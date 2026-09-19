import type { FrameState, FrameStatus, SubtitleCue, SubtitleSelection } from '@shared/types';
import { MAX_CONSECUTIVE_ERRORS, TIMING } from '@shared/constants';
import { log } from '@shared/logger';
import type { Settings } from '@shared/settings';
import { ActiveVideoDetector } from './ActiveVideoDetector';
import { ContextMenu } from './ContextMenu';
import { OverlayRenderer } from './OverlayRenderer';
import { PositionTracker } from './PositionTracker';
import { SelectionManager, type ClearReason } from './SelectionManager';
import { UrlWatcher } from './UrlWatcher';
import { selectAdapter } from './adapters/AdapterRegistry';
import type { AdapterContext, AdapterPresentation, SubtitleAdapter } from './adapters/types';
import { Disposer, findPlayerRoot, throttleTrailing } from './dom';

/**
 * Owns the lifecycle of everything that touches a video (§36, §57, §58).
 *
 * One engine per frame. It is the only place that starts or stops anything, which is what
 * makes cleanup provable: a binding is a single object, and tearing it down releases every
 * observer, listener and DOM node that binding created.
 *
 * Failure policy: any throw in the cue pipeline is caught and counted. After
 * MAX_CONSECUTIVE_ERRORS the engine restores the site's own captions and stands down
 * until the next navigation. The video is never touched on any path — not paused, not
 * seeked, not re-sourced.
 */

interface Binding {
  video: HTMLVideoElement;
  adapter: SubtitleAdapter;
  renderer: OverlayRenderer;
  tracker: PositionTracker;
  selection: SelectionManager;
  menu: ContextMenu;
  playerRoot: HTMLElement;
  /** Kept so the health check can tell whether what we mirror still exists. */
  presentation: AdapterPresentation;
  cue: SubtitleCue | null;
  dispose: () => void;
}

export class SubtitleEngine {
  private readonly disposer = new Disposer();
  private detector: ActiveVideoDetector | null = null;
  private urlWatcher: UrlWatcher | null = null;
  private binding: Binding | null = null;
  private sourceWatcher: Disposer | null = null;
  private state: FrameState = 'disabled';
  private errorCount = 0;
  private running = false;
  private rebindPending = false;
  /** True only while SubSelect is holding a pause it started itself. */
  private pausedByUs = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private settings: Settings,
    private readonly onSelection: (selection: SubtitleSelection | null) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.errorCount = 0;
    this.setState('no-video');

    this.detector = new ActiveVideoDetector((video) => this.onVideoChange(video));
    this.detector.start();

    this.urlWatcher = new UrlWatcher(() => this.onNavigate());
    this.urlWatcher.start();

    /*
     * Switching tabs must not cost anything.
     *
     * The binding used to be torn down whenever the tab was hidden, to save work in the
     * background. Coming back could not undo it: the detector still held the same video,
     * so re-evaluating decided nothing had changed and never notified, and the engine sat
     * unbound until the video itself was replaced. Tearing down also resumed a video that
     * had been paused to read a word, so a quick look at another tab restarted playback.
     *
     * Nothing is released now. A hidden tab's player is usually paused, so the observers
     * sit idle anyway, and the health check below already stands down while hidden. On the
     * way back the position is re-measured, because the window may have been resized.
     */
    this.disposer.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') return;
      this.ensureBound();
      this.binding?.tracker.refresh();
      this.detector?.refresh();
    });

    this.disposer.listen(document, 'fullscreenchange', () => this.onFullscreenChange());
    this.disposer.listen(document, 'webkitfullscreenchange', () => this.onFullscreenChange());

    this.healthTimer = setInterval(() => this.checkHealth(), TIMING.healthCheckMs);
    this.disposer.add(() => {
      if (this.healthTimer !== null) clearInterval(this.healthTimer);
      this.healthTimer = null;
    });

    log.debug('engine started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.releaseBinding();
    this.detector?.stop();
    this.detector = null;
    this.urlWatcher?.stop();
    this.urlWatcher = null;
    this.disposer.dispose();
    this.setState('disabled');

    log.debug('engine stopped');
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.binding?.selection.updateSettings(settings);
    this.binding?.renderer.applyAppearance(settings);
    this.binding?.menu.updateSettings(settings);
  }

  /**
   * Publishes a selection and drives the context menu from it.
   *
   * Selections arrive once per completed gesture, so the menu opens when the user has
   * finished choosing rather than flickering along with a drag.
   */
  /**
   * Pauses while a word is being read, and resumes when the reader is done.
   *
   * Only a video SubSelect paused itself is ever resumed. A video the viewer had already
   * paused stays paused, and pressing play while reading clears the claim for good — so
   * the extension can never take playback back off the person watching.
   *
   * §58 forbids pausing the video, but that clause is about failure: an extension that
   * breaks must not break playback with it. This is the interaction itself asking, which
   * §43 allows, and it is a setting.
   */
  private pauseForReading(video: HTMLVideoElement): void {
    if (!this.settings.pauseOnSelect || this.pausedByUs) return;
    if (video.paused || video.ended) return;

    try {
      video.pause();
      this.pausedByUs = true;
    } catch (error) {
      log.debug('could not pause for reading', error);
    }
  }

  private resumeAfterReading(video: HTMLVideoElement): void {
    if (!this.pausedByUs) return;
    this.pausedByUs = false;

    /*
     * Never start playback in a tab the viewer is not looking at.
     *
     * Dismissing a selection is a gesture in this tab, so that path is always visible. The
     * teardown path is not: `binding.dispose` resumes so a video is never left paused
     * because SubSelect went away, and the engine is torn down by anything that writes
     * `enabled: false` — the Alt+Shift+S shortcut, the popup switch, the settings page —
     * none of which has to happen in this tab. That made turning the feature off from
     * somewhere else start a video playing out of a background tab, which is the worst
     * thing a muted, unattended tab can do.
     *
     * The claim is still released, so SubSelect is not holding the video either. Coming
     * back to a paused video costs one press of play; coming back to sound already playing
     * costs finding which of thirty tabs it is.
     */
    if (document.visibilityState !== 'visible') {
      log.debug('not resuming: this tab is in the background');
      return;
    }

    try {
      // Resuming follows a click or a key press, so autoplay policy allows it; a rejected
      // promise would only mean the player refused, which is the player's call to make.
      void video.play()?.catch(() => {});
    } catch (error) {
      log.debug('could not resume after reading', error);
    }
  }

  private publishSelection(selection: SubtitleSelection | null, reason: ClearReason = 'user'): void {
    const binding = this.binding;
    if (binding) {
      if (selection) {
        this.pauseForReading(binding.video);
        this.showMenu(binding, selection);
      }
      /*
       * A caption changing takes the highlighted words off screen, but it is not the user
       * saying they are finished. Captions change every few seconds, so closing the menu
       * here would make the answer impossible to read, and resuming would snatch the video
       * back mid-sentence. Both wait for an actual dismissal; the menu keeps its own copy
       * of the selection, so it stays useful after the words are gone.
       */
      else if (reason === 'user') {
        binding.menu.hide();
        this.resumeAfterReading(binding.video);
      }
    }
    this.onSelection(selection);
  }

  private showMenu(binding: Binding, selection: SubtitleSelection): void {
    const anchor = binding.renderer.selectionRect();
    if (!anchor) return;
    binding.menu.show(selection, anchor, this.menuBounds(binding));
  }

  private repositionMenu(): void {
    const binding = this.binding;
    if (!binding?.menu.isVisible()) return;

    // No anchor means the caption the selection came from is gone. The menu keeps the
    // selection it was opened with, and re-places against its last known anchor so that
    // growing content still cannot push it over the subtitle.
    const anchor = binding.renderer.selectionRect();
    if (anchor) binding.menu.reposition(anchor, this.menuBounds(binding));
    else binding.menu.reposition();
  }

  /** The menu stays inside the video box, which is also what the player may clip to. */
  private menuBounds(binding: Binding): { left: number; top: number; right: number; bottom: number } {
    const rect = binding.video.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }

  /**
   * Keeps the overlay inside whatever element went fullscreen (§37).
   *
   * Only the fullscreen element's subtree renders, so an overlay outside it disappears.
   * Normally the player container goes fullscreen and our layer is already within it; this
   * covers the players where it is not.
   *
   * A bare `<video>` going fullscreen is the one case with no answer: its children are
   * fallback content and are never rendered, so nothing can be overlaid on it. The overlay
   * stands down for the duration rather than pretending.
   */
  private onFullscreenChange(): void {
    const binding = this.binding;
    const layer = binding?.renderer.getLayer();
    if (!binding || !layer) return;

    const fullscreen = document.fullscreenElement;

    if (!fullscreen) {
      binding.renderer.restoreParent();
      binding.menu.reparentTo(binding.playerRoot);
      binding.renderer.setSuppressed(false);
      return;
    }

    if (fullscreen.contains(layer)) {
      binding.renderer.setSuppressed(false);
      return;
    }

    if (fullscreen instanceof HTMLVideoElement) {
      log.debug('a bare <video> is fullscreen; no overlay is possible');
      binding.selection.clear();
      binding.renderer.setSuppressed(true);
      return;
    }

    binding.renderer.reparentTo(fullscreen as HTMLElement);
    binding.menu.reparentTo(fullscreen as HTMLElement);
    binding.renderer.setSuppressed(false);
  }

  getStatus(): FrameStatus {
    const status: FrameStatus = { state: this.state, url: location.href };
    if (this.binding) {
      status.adapterId = this.binding.adapter.id;
      if (this.binding.cue) {
        status.source = this.binding.cue.source;
        if (this.binding.cue.language) status.language = this.binding.cue.language;
      }
    }
    return status;
  }

  /**
   * Keeps "on" meaning on.
   *
   * MutationObservers only report on subtrees that still exist, so a player that rebuilds
   * itself takes both our overlay and the nodes we were watching with it. The engine is
   * then bound to elements that are no longer in the document, nothing will ever fire
   * again, and the feature looks dead until the extension is toggled — which is precisely
   * what a re-render, a seek or an episode change was doing.
   *
   * So liveness is checked rather than assumed. Everything here is an `isConnected` read;
   * there is no scanning, and it stops while the tab is hidden.
   */
  private checkHealth(): void {
    if (!this.running || document.visibilityState === 'hidden') return;

    if (!this.binding) {
      this.ensureBound();
      return;
    }
    const binding = this.binding;

    const presentation = binding.presentation;

    // An overlay the page removed is simply put back. Rebuilding the binding would also
    // work, but it discards the words, the selection and any open menu to achieve the same
    // thing — and a player that does this does it between every pair of subtitles.
    const layerAlive = binding.renderer.ensureMounted();

    const detached =
      !binding.video.isConnected ||
      !binding.playerRoot.isConnected ||
      // Nowhere left to put the overlay, so no click can reach a word any more.
      !layerAlive ||
      /*
       * Liveness is the mount point, never the caption element itself.
       *
       * Plenty of players — YouTube among them — delete the caption element in the silence
       * between two subtitles and build a new one for the next line. Reading that as a dead
       * binding meant the whole engine was torn down and rebuilt in *every gap between
       * subtitles*: the rebuild then raced the next cue and regularly lost, which is what
       * made captions appear to be skipped, and it destroyed the context menu each time, so
       * an answer could not be read for longer than one subtitle.
       *
       * The mount parent is the thing that has to survive, because that is where the overlay
       * lives. An absent caption element just means nobody is speaking.
       */
      (presentation.mode === 'mirror' && !presentation.mountParent.isConnected);

    if (!detached) return;

    log.debug('binding went stale; rebuilding');
    const video = binding.video;
    this.releaseBinding();

    if (video.isConnected) this.bind(video);
    else this.detector?.refresh();
  }

  /** SPA navigation: drop everything and let the detector find the new player (§36). */
  private onNavigate(): void {
    log.debug('navigation detected');
    this.releaseBinding();
    this.errorCount = 0;
    this.detector?.refresh();
  }

  /**
   * Rebinds on an adapter's request, deferred to a fresh task.
   *
   * `invalidate` is called from inside the adapter's own observer callback, so tearing the
   * binding down synchronously would destroy the code that is still running.
   */
  private requestRebind(video: HTMLVideoElement): void {
    if (this.rebindPending) return;
    this.rebindPending = true;

    setTimeout(() => {
      this.rebindPending = false;
      if (!this.running) return;

      this.releaseBinding();

      /*
       * A player that swaps its <video> on a transition — Prime Video does — used to leave
       * us here holding a dead binding and never looking again, so the extension appeared
       * to stop working until it was toggled off and on. Hand the search back to the
       * detector instead of giving up.
       */
      if (!video.isConnected) {
        this.detector?.refresh();
        return;
      }
      this.bind(video);
    }, 0);
  }

  private onVideoChange(video: HTMLVideoElement | null): void {
    this.releaseBinding();

    if (!video) {
      this.setState('no-video');
      return;
    }

    this.bind(video);
  }

  /**
   * Binds to the detector's current video if nothing is bound.
   *
   * Every recovery path used to go through `detector.refresh()`, which re-evaluates and
   * notifies only when the *best video changes*. After a binding was dropped with the
   * video still in place — a hidden tab, a burst of errors — the detector saw the same
   * element it already held, decided nothing had changed, and said nothing. The engine
   * sat unbound with a perfectly good video in front of it. This asks the detector what it
   * has and binds to it directly, falling back to a fresh search only when that video is
   * gone.
   */
  private ensureBound(): void {
    if (!this.running || this.binding) return;

    const video = this.detector?.getCurrent();
    if (video?.isConnected) this.bind(video);
    else this.detector?.refresh();
  }

  private bind(video: HTMLVideoElement): void {
    const context: AdapterContext = {
      video,
      playerRoot: findPlayerRoot(video),
      invalidate: () => this.requestRebind(video),
      ...(this.settings.subtitleLanguage ? { language: this.settings.subtitleLanguage } : {}),
    };

    const adapter = selectAdapter(context);
    if (!adapter) {
      // Captions are commonly off when a page loads. Rather than polling, watch for the
      // two things that can change the answer, then try again.
      this.setState('no-subtitle-source');
      this.watchForSource(video, context.playerRoot);
      return;
    }

    let binding: Binding;
    try {
      adapter.attach(context);

      const presentation = adapter.getPresentation();
      if (!presentation) {
        adapter.detach();
        this.setState('no-subtitle-source');
        this.watchForSource(video, context.playerRoot);
        return;
      }

      const renderer = new OverlayRenderer(presentation);
      const layer = renderer.mount();
      renderer.applyAppearance(this.settings);

      const tracker = new PositionTracker(layer, video, presentation, (box) => {
        renderer.applyBox(box);
        this.repositionMenu();
      });

      const selection = new SelectionManager(
        renderer,
        () => this.binding?.cue ?? null,
        (value, reason) => this.publishSelection(value, reason),
        this.settings,
      );

      const menu = new ContextMenu(context.playerRoot, this.settings, {
        // The menu acts on the selection it was opened with, which may have outlived the
        // caption it came from.
        onCopy: (text) => selection.copyText(text),
        onDismiss: () => {
          selection.clear('user');
          menu.hide();
        },
        onResized: () => this.repositionMenu(),
      });
      selection.setUiGuard((node) => menu.contains(node));

      binding = {
        video,
        adapter,
        renderer,
        tracker,
        selection,
        menu,
        playerRoot: context.playerRoot,
        presentation,
        cue: null,
        dispose: () => {
          menu.destroy();
          selection.detach();
          tracker.stop();
          renderer.destroy();
          adapter.detach();
        },
      };

      /*
       * If the viewer presses play while reading, the claim is released for good. Without
       * this, dismissing the selection later would call play() on a video that is already
       * playing — harmless — but a subsequent pause-and-resume cycle could fight whatever
       * the viewer had chosen. Playback belongs to the person watching.
       */
      const onPlay = (): void => {
        this.pausedByUs = false;
      };
      video.addEventListener('play', onPlay);
      const disposeBinding = binding.dispose;
      binding.dispose = () => {
        video.removeEventListener('play', onPlay);
        // Never leave a video paused because SubSelect went away.
        this.resumeAfterReading(video);
        disposeBinding();
      };

      this.binding = binding;
      tracker.start();
      selection.attach();

      const unsubscribe = adapter.observeChanges((cue) => this.onCue(cue));
      const previousDispose = binding.dispose;
      binding.dispose = () => {
        unsubscribe();
        previousDispose();
      };

      this.setState(binding.cue ? 'active' : 'waiting-for-cue');
      log.debug(`bound via ${adapter.id}`);
    } catch (error) {
      log.error('failed to bind', error);
      this.releaseBinding();
      try {
        adapter.detach();
      } catch {
        // Already partly torn down; nothing more to release.
      }
      this.fail();
    }
  }

  private onCue(cue: SubtitleCue | null): void {
    const binding = this.binding;
    if (!binding) return;

    try {
      const previous = binding.cue;
      const changed = cue?.id !== previous?.id;

      /*
       * Auto-generated captions grow a word at a time rather than being replaced line by
       * line — YouTube's are the common case. Treating every growth as a new caption
       * dropped the selection two or three times a second, which made the feature unusable
       * exactly where a learner most wants it.
       *
       * When the new text merely extends the old, the words already on screen are the same
       * words at the same offsets, so the selection survives. Word ids are derived from
       * those offsets, which is what makes this safe rather than a guess.
       */
      const extended = Boolean(previous && cue && cue.text.startsWith(previous.text));
      binding.cue = cue;

      // A genuinely new caption invalidates whatever was selected in the old one (§16).
      if (changed && !extended) binding.selection.clear('cue-change');

      binding.renderer.render(cue);
      if (changed && extended && cue) binding.selection.refreshAfterExtend(cue.id);
      if (cue) binding.tracker.refresh();

      this.setState(cue ? 'active' : 'waiting-for-cue');
      this.errorCount = 0;
    } catch (error) {
      log.error('cue pipeline failed', error);
      this.fail();
    }
  }

  /**
   * Waits for something that could make a subtitle source appear: a text track being
   * enabled, or the player inserting a caption container. Both are events, so no timer is
   * involved, and the watcher is released as soon as a source is found.
   */
  private watchForSource(video: HTMLVideoElement, playerRoot: HTMLElement): void {
    this.sourceWatcher?.dispose();
    const watcher = new Disposer();
    this.sourceWatcher = watcher;

    const retry = throttleTrailing(() => {
      if (!this.running || this.binding) return;
      watcher.dispose();
      if (this.sourceWatcher === watcher) this.sourceWatcher = null;
      this.bind(video);
    }, 1000);
    watcher.add(() => retry.cancel());

    const tracks = video.textTracks;
    for (const type of ['change', 'addtrack'] as const) {
      const handler = (): void => retry();
      tracks.addEventListener(type, handler);
      watcher.add(() => tracks.removeEventListener(type, handler));
    }

    const observer = new MutationObserver(() => retry());
    observer.observe(playerRoot, { childList: true, subtree: true });
    watcher.add(() => observer.disconnect());
  }

  private releaseBinding(): void {
    this.sourceWatcher?.dispose();
    this.sourceWatcher = null;

    const binding = this.binding;
    this.binding = null;
    if (!binding) return;

    try {
      binding.dispose();
    } catch (error) {
      log.error('teardown failed', error);
    }
    this.onSelection(null);
  }

  /**
   * Fail-safe (§58). The site's captions come back, we let go of the player, and the
   * video carries on exactly as it would have without the extension installed.
   */
  private fail(): void {
    this.errorCount++;
    this.releaseBinding();
    this.setState('error');

    /*
     * Standing down used to mean stopping the detector and never starting it again, so a
     * burst of errors during a player transition left the extension dead until it was
     * toggled off and on. Backing off is right; giving up is not. The binding is released,
     * the engine waits, and then it tries again from scratch — "on" has to mean it keeps
     * working without being nursed.
     */
    if (this.errorCount >= MAX_CONSECUTIVE_ERRORS) {
      log.error(`standing down after ${this.errorCount} failures; retrying shortly`);
      if (this.recoveryTimer === null) {
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          if (!this.running) return;
          this.errorCount = 0;
          // Not refresh(): the video that failed is usually still the current one, and a
          // refresh would look at it, see no change, and say nothing.
          this.ensureBound();
        }, TIMING.errorRecoveryMs);
      }
      return;
    }

    this.detector?.refresh();
  }

  private setState(state: FrameState): void {
    this.state = state;
  }
}
