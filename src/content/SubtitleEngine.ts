import type { FrameState, FrameStatus, SubtitleCue, SubtitleSelection } from '@shared/types';
import { MAX_CONSECUTIVE_ERRORS } from '@shared/constants';
import { log } from '@shared/logger';
import type { Settings } from '@shared/settings';
import { ActiveVideoDetector } from './ActiveVideoDetector';
import { ContextMenu } from './ContextMenu';
import { OverlayRenderer } from './OverlayRenderer';
import { PositionTracker } from './PositionTracker';
import { SelectionManager, type ClearReason } from './SelectionManager';
import { UrlWatcher } from './UrlWatcher';
import { selectAdapter } from './adapters/AdapterRegistry';
import type { AdapterContext, SubtitleAdapter } from './adapters/types';
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

    // Nothing needs to be tracked while the tab is in the background.
    this.disposer.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.releaseBinding();
      else this.detector?.refresh();
    });

    this.disposer.listen(document, 'fullscreenchange', () => this.onFullscreenChange());
    this.disposer.listen(document, 'webkitfullscreenchange', () => this.onFullscreenChange());

    log.debug('engine started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

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
  private publishSelection(selection: SubtitleSelection | null, reason: ClearReason = 'user'): void {
    const binding = this.binding;
    if (binding) {
      if (selection) this.showMenu(binding, selection);
      // A caption changing takes the highlighted words off screen, but it is not the user
      // asking to close the menu they just opened — and captions change every few seconds,
      // so closing here would make Translate and Definition impossible to read. The menu
      // holds its own copy of the selection, so it stays useful after the words are gone.
      else if (reason === 'user') binding.menu.hide();
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

    // No anchor means the caption the selection came from is gone. The menu stays where it
    // is rather than being hidden — it still holds the selection the user opened it with.
    const anchor = binding.renderer.selectionRect();
    if (anchor) binding.menu.reposition(anchor, this.menuBounds(binding));
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
      if (!this.running || !video.isConnected) return;
      this.releaseBinding();
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
        onCopy: (text) => void selection.copyText(text),
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
        cue: null,
        dispose: () => {
          menu.destroy();
          selection.detach();
          tracker.stop();
          renderer.destroy();
          adapter.detach();
        },
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
      const changed = cue?.id !== binding.cue?.id;
      binding.cue = cue;

      // A new caption invalidates whatever was selected in the old one (§16).
      if (changed) binding.selection.clear('cue-change');

      binding.renderer.render(cue);
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

    if (this.errorCount >= MAX_CONSECUTIVE_ERRORS) {
      log.error(`standing down after ${this.errorCount} failures; playback is unaffected`);
      this.setState('error');
      this.detector?.stop();
      this.detector = null;
      return;
    }

    this.setState('error');
    this.detector?.refresh();
  }

  private setState(state: FrameState): void {
    this.state = state;
  }
}
