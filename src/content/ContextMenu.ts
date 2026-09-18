import type { SubtitleSelection } from '@shared/types';
import { CLASS, MENU_GAP_PX, MENU_MARGIN_PX } from '@shared/constants';
import { sendMessage } from '@shared/messages';
import type { Settings } from '@shared/settings';
import type { DictionarySense } from '../providers/types';
import { placeMenu, type Box } from './menuPlacement';
import { isSpeechAvailable, speak, stopSpeaking, willUseRemoteVoice } from './speech';
import { Disposer } from './dom';

/**
 * The contextual menu that appears next to a selection (§16, §47).
 *
 * It offers only actions that work. Translate, Dictionary and Save belong to the provider
 * work in Phase 4 and are absent rather than present-and-inert — a menu item that does
 * nothing teaches the user the menu is not worth opening.
 *
 * ## Placement and fullscreen
 *
 * The menu is mounted inside the player container, like the overlay, so it survives
 * fullscreen for free: only the fullscreen element's subtree renders, and this is inside
 * it. The cost is that a player with `overflow: hidden` can clip it, which is why
 * placement stays within the player box and prefers *above* the caption — where the room
 * is, and where the menu does not cover the picture.
 *
 * ## Focus
 *
 * The menu deliberately does **not** take focus when it opens. Pulling focus out of the
 * player would break space-to-pause and arrow-key seeking, which §43 says not to interfere
 * with. It is reachable by Tab, and once focus is inside, arrow keys move between items.
 */

export interface ContextMenuCallbacks {
  /** Resolves false when the clipboard refused the write, so the menu can say so. */
  onCopy: (text: string) => Promise<boolean>;
  onDismiss: () => void;
  /** The menu changed size and needs placing again. */
  onResized: () => void;
}

interface MenuAction {
  id: string;
  label: string;
  icon: string;
  run: () => void;
}

interface MenuResult {
  state: 'loading' | 'ok' | 'error' | 'notice';
  text?: string;
  senses?: DictionarySense[];
  /** Provider id, shown so the user always knows where an answer came from. */
  via?: string;
  settingsLink?: boolean;
}

export class ContextMenu {
  private readonly disposer = new Disposer();
  private element: HTMLElement | null = null;
  private items: HTMLButtonElement[] = [];
  private visible = false;
  /** Carried into Save, so saving after translating keeps the translation (§19). */
  private lastTranslation: string | null = null;

  constructor(
    private readonly host: HTMLElement,
    private settings: Settings,
    private readonly callbacks: ContextMenuCallbacks,
  ) {}

  updateSettings(settings: Settings): void {
    this.settings = settings;
    if (this.element) this.element.setAttribute('data-ss-theme', settings.theme);
    if (!settings.showContextMenu) this.hide();
  }

  /** Opens the menu for a selection, anchored to the rect its words occupy. */
  show(selection: SubtitleSelection, anchor: Box, bounds: Box): void {
    if (!this.settings.showContextMenu) return;

    const element = this.ensureElement();
    // A new selection means any previous answer is about a different word.
    this.lastTranslation = null;
    this.renderContents(selection);
    this.clearResult();
    element.removeAttribute('hidden');
    this.visible = true;
    this.position(anchor, bounds);
  }

  /**
   * Moves an open menu without rebuilding it.
   *
   * Used when the player resizes or enters fullscreen: re-rendering would throw away the
   * DOM the user may currently have focus in.
   */
  reposition(anchor: Box, bounds: Box): void {
    if (this.visible) this.position(anchor, bounds);
  }

  private position(anchor: Box, bounds: Box): void {
    const element = this.element;
    if (!element) return;

    // Measured while laid out but invisible, so the first painted frame is already in
    // place — the browser does not paint in the middle of this function.
    element.setAttribute('data-ss-measuring', 'true');

    // Measure unconstrained first, so the natural height is what placement reasons about.
    element.style.setProperty('--ss-menu-max-h', 'none');
    const rect = element.getBoundingClientRect();
    const origin = this.resolveOrigin();
    const placement = placeMenu({
      anchor,
      bounds,
      menu: { width: rect.width, height: rect.height },
      gap: MENU_GAP_PX,
      margin: MENU_MARGIN_PX,
      preference: this.settings.contextMenuPlacement,
    });

    element.style.setProperty('--ss-menu-max-h', `${Math.round(placement.maxHeight)}px`);
    element.style.setProperty('--ss-menu-x', `${Math.round(placement.x - origin.x)}px`);
    element.style.setProperty('--ss-menu-y', `${Math.round(placement.y - origin.y)}px`);
    element.setAttribute('data-ss-side', placement.side);
    if (origin.fixed) element.setAttribute('data-ss-fixed', 'true');
    else element.removeAttribute('data-ss-fixed');
    element.removeAttribute('data-ss-measuring');
  }

  hide(): void {
    stopSpeaking();
    this.visible = false;
    this.element?.setAttribute('hidden', '');
  }

  isVisible(): boolean {
    return this.visible;
  }

  contains(node: Node | null): boolean {
    return Boolean(node && this.element?.contains(node));
  }

  destroy(): void {
    stopSpeaking();
    this.disposer.dispose();
    this.element?.remove();
    this.element = null;
    this.items = [];
    this.visible = false;
  }

  /** Re-parents the menu, e.g. when the overlay follows an element into fullscreen. */
  reparentTo(host: HTMLElement): void {
    if (this.element && this.element.parentElement !== host) host.appendChild(this.element);
  }

  private ensureElement(): HTMLElement {
    if (this.element?.isConnected) return this.element;

    const element = this.element ?? document.createElement('div');
    element.className = CLASS.menu;
    element.setAttribute('role', 'menu');
    element.setAttribute('aria-label', 'Subtitle actions');
    element.setAttribute('data-ss-theme', this.settings.theme);
    element.setAttribute('hidden', '');

    /*
     * The menu is interactive, unlike the rest of the layer, but its events must not reach
     * the player underneath — clicking Copy must never also pause the video (§43).
     *
     * This has to run in the **bubble** phase. Stopping propagation during capture on this
     * element halts the event on its way *down*, so it never reaches the button that was
     * clicked and no action ever runs — which is exactly how this was broken. Bubbling
     * instead lets the target's own handler fire first, then stops the event here before
     * any ancestor of the menu sees it.
     */
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'] as const) {
      this.disposer.listen(element, type, (event) => event.stopPropagation());
    }
    this.disposer.listen(element, 'keydown', (event) => this.onKeyDown(event as KeyboardEvent));

    /*
     * Escape has to reach the menu even when focus is elsewhere.
     *
     * The menu deliberately does not take focus (§43 — stealing it would break
     * space-to-pause), so the element listener above only fires once the user has tabbed
     * in. And the menu now outlives the caption it came from, so by the time Escape is
     * pressed there is often no selection left for SelectionManager to clear, and its own
     * Escape handler returns early. Without this, an open menu could not be dismissed by
     * keyboard at all.
     */
    this.disposer.listen(
      document,
      'keydown',
      (event) => {
        if ((event as KeyboardEvent).key !== 'Escape' || !this.visible) return;
        event.stopPropagation();
        this.callbacks.onDismiss();
      },
      { capture: true },
    );

    this.host.appendChild(element);
    this.element = element;
    return element;
  }

  private actionsFor(selection: SubtitleSelection): MenuAction[] {
    const actions: MenuAction[] = [];

    actions.push({
      id: 'translate',
      label: 'Translate',
      icon: '🌐',
      run: () => void this.runTranslate(selection),
    });

    actions.push({
      id: 'define',
      label: 'Definition',
      icon: '📖',
      run: () => void this.runLookup(selection),
    });

    if (this.settings.speechEnabled && isSpeechAvailable()) {
      actions.push({
        id: 'pronounce',
        label: 'Pronounce',
        icon: '🔊',
        run: () => void this.runPronounce(selection),
      });
    }

    actions.push({
      id: 'save',
      label: 'Save',
      icon: '💾',
      run: () => void this.runSave(selection),
    });

    actions.push({
      id: 'copy',
      label: 'Copy',
      icon: '📋',
      // Reported in the menu like every other action. The overlay's own "Copied ✓" flash
      // is easy to miss, and a refused clipboard write would otherwise be silent.
      run: () =>
        void this.callbacks.onCopy(selection.text).then((ok) =>
          this.setResult(
            ok
              ? { state: 'ok', text: 'Copied ✓' }
              : { state: 'error', text: 'Could not copy — the page blocked clipboard access.' },
          ),
        ),
    });

    return actions;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private async runTranslate(selection: SubtitleSelection): Promise<void> {
    this.setResult({ state: 'loading', text: 'Translating…' });

    const outcome = await sendMessage({
      type: 'TRANSLATE_SELECTION',
      text: selection.text,
      ...(selection.context ? { context: selection.context } : {}),
      ...(selection.language ? { sourceLanguage: selection.language } : {}),
    });

    if (!outcome) {
      this.setResult({ state: 'error', text: "Couldn't retrieve translation. Try again." });
      return;
    }
    if (!outcome.ok) {
      this.showProviderProblem(outcome);
      return;
    }

    this.lastTranslation = outcome.data.text;
    this.setResult({ state: 'ok', text: outcome.data.text, via: outcome.data.providerId });
  }

  private async runLookup(selection: SubtitleSelection): Promise<void> {
    this.setResult({ state: 'loading', text: 'Looking up…' });

    // The headword, not the raw slice: a dictionary wants `geht's`, not `geht's?` (§40).
    const word = selection.words.find((candidate) => candidate.isWordLike);
    const term = selection.words.length === 1 && word ? word.normalizedText : selection.text;

    const outcome = await sendMessage({
      type: 'LOOKUP_WORD',
      text: term,
      ...(selection.language ? { language: selection.language } : {}),
    });

    if (!outcome) {
      this.setResult({ state: 'error', text: "Couldn't retrieve the definition. Try again." });
      return;
    }
    if (!outcome.ok) {
      this.showProviderProblem(outcome);
      return;
    }

    this.setResult({ state: 'ok', senses: outcome.data.senses, via: outcome.data.providerId });
  }

  /**
   * Speaks the selection, preferring a real human recording.
   *
   * Wikimedia's Lingua Libre recordings are native speakers, which beats synthesis
   * outright for a learner. Everything about that path can fail — no recording for the
   * word, no approval for the host, a page CSP that blocks cross-origin media — so speech
   * synthesis is the floor underneath it and always runs if the audio does not.
   */
  private async runPronounce(selection: SubtitleSelection): Promise<void> {
    const speakIt = (): void => {
      if (speak(selection.text, selection.language)) this.setResult({ state: 'ok', text: 'Speaking…' });
      else this.setResult({ state: 'error', text: 'Could not pronounce this.' });
    };

    if (this.settings.pronunciationProvider !== 'wikimedia') {
      speakIt();
      return;
    }

    this.setResult({ state: 'loading', text: 'Finding a recording…' });
    const outcome = await sendMessage({
      type: 'FIND_PRONUNCIATION',
      text: selection.text,
      ...(selection.language ? { language: selection.language } : {}),
    });

    if (!outcome?.ok) {
      speakIt();
      return;
    }

    try {
      const audio = new Audio(outcome.data.url);
      audio.addEventListener('error', speakIt, { once: true });
      await audio.play();
      this.setResult({ state: 'ok', text: outcome.data.title, via: 'Wikimedia' });
    } catch {
      // A page Content-Security-Policy can refuse cross-origin media even to us.
      speakIt();
    }
  }

  private async runSave(selection: SubtitleSelection): Promise<void> {
    const outcome = await sendMessage({
      type: 'SAVE_WORD',
      word: {
        word: selection.text,
        context: selection.context ?? selection.text,
        ...(this.lastTranslation ? { translation: this.lastTranslation } : {}),
        ...(selection.language ? { sourceLanguage: selection.language } : {}),
        website: location.hostname,
      },
    });

    if (outcome?.ok) {
      const total = outcome.data.total;
      this.setResult({ state: 'ok', text: `Saved · ${total} ${total === 1 ? 'word' : 'words'}` });
    } else {
      this.setResult({ state: 'error', text: outcome?.message ?? 'Could not save this word.' });
    }
  }

  /**
   * Renders a provider failure as something actionable.
   *
   * `no-permission` is the interesting one: it means a remote provider is configured but
   * has not been approved to receive text yet, so the menu asks by name rather than
   * failing (§33).
   */
  private showProviderProblem(outcome: { kind: string; message: string; origin?: string }): void {
    const needsSettings = outcome.kind === 'not-configured' || outcome.kind === 'no-permission';
    this.setResult({
      state: needsSettings ? 'notice' : 'error',
      text: outcome.message,
      settingsLink: needsSettings,
    });
  }

  // ── Result area ─────────────────────────────────────────────────────────────

  private setResult(result: MenuResult): void {
    const element = this.element;
    if (!element) return;

    const panel = document.createElement('div');
    panel.className = CLASS.menuResult;
    panel.dataset.ssState = result.state;
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');

    if (result.senses) {
      const list = document.createElement('ol');
      list.className = CLASS.menuSenses;
      for (const sense of result.senses.slice(0, 4)) {
        const item = document.createElement('li');
        if (sense.partOfSpeech) {
          const pos = document.createElement('span');
          pos.className = CLASS.menuPos;
          pos.textContent = sense.partOfSpeech;
          item.appendChild(pos);
        }
        item.appendChild(document.createTextNode(sense.definition));
        list.appendChild(item);
      }
      panel.appendChild(list);
    } else if (result.text) {
      const line = document.createElement('p');
      line.className = CLASS.menuResultText;
      line.textContent = result.text;
      panel.appendChild(line);
    }

    if (result.via) {
      const via = document.createElement('p');
      via.className = CLASS.menuNote;
      via.textContent = `via ${result.via}`;
      panel.appendChild(via);
    }

    if (result.settingsLink) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = CLASS.menuLink;
      button.textContent = 'Open settings';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        void sendMessage({ type: 'OPEN_OPTIONS' });
      });
      panel.appendChild(button);
    }

    element.querySelector(`.${CLASS.menuResult}`)?.remove();
    element.appendChild(panel);

    // The menu just changed height, so whatever placement it had is now wrong.
    this.callbacks.onResized();
  }

  private clearResult(): void {
    this.element?.querySelector(`.${CLASS.menuResult}`)?.remove();
  }

  private renderContents(selection: SubtitleSelection): void {
    const element = this.element;
    if (!element) return;

    const header = document.createElement('div');
    header.className = CLASS.menuHeader;

    const term = document.createElement('p');
    term.className = CLASS.menuTerm;
    term.textContent = selection.text;
    header.appendChild(term);

    // The surrounding sentence, shown only when it adds something (§15).
    if (selection.context && selection.context !== selection.text) {
      const context = document.createElement('p');
      context.className = CLASS.menuContext;
      context.textContent = selection.context.replace(/\n/g, ' ');
      header.appendChild(context);
    }

    const list = document.createElement('div');
    list.className = `${CLASS.menu}-items`;

    this.items = this.actionsFor(selection).map((action, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = CLASS.menuItem;
      button.setAttribute('role', 'menuitem');
      button.dataset.ssAction = action.id;
      // Roving tabindex: one stop into the menu, then arrow keys.
      button.tabIndex = index === 0 ? 0 : -1;

      const icon = document.createElement('span');
      icon.className = CLASS.menuIcon;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = action.icon;

      const label = document.createElement('span');
      label.textContent = action.label;

      button.append(icon, label);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        action.run();
      });
      return button;
    });

    list.append(...this.items);
    element.replaceChildren(header, list);

    // Speaking a word through a network voice sends it off the device, so say so rather
    // than let it happen silently (§33).
    if (
      this.settings.speechEnabled &&
      isSpeechAvailable() &&
      willUseRemoteVoice(selection.language)
    ) {
      const note = document.createElement('p');
      note.className = CLASS.menuNote;
      note.textContent = 'No offline voice for this language — Pronounce uses an online voice.';
      element.appendChild(note);
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.items.length === 0) return;

    const current = this.items.findIndex((item) => item === document.activeElement);

    let next = -1;
    switch (event.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % this.items.length;
        break;
      case 'ArrowUp':
        next = current < 0 ? this.items.length - 1 : (current - 1 + this.items.length) % this.items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.items.length - 1;
        break;
      case 'Escape':
        event.stopPropagation();
        this.callbacks.onDismiss();
        return;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    for (const [index, item] of this.items.entries()) item.tabIndex = index === next ? 0 : -1;
    this.items[next]?.focus();
  }

  /** Same offsetParent-relative convention as PositionTracker, for the same reason. */
  private resolveOrigin(): { x: number; y: number; fixed: boolean } {
    const parent = this.element?.offsetParent;
    if (!(parent instanceof HTMLElement)) return { x: 0, y: 0, fixed: true };

    const rect = parent.getBoundingClientRect();
    const style = getComputedStyle(parent);
    return {
      x: rect.left + parseFloat(style.borderLeftWidth || '0'),
      y: rect.top + parseFloat(style.borderTopWidth || '0'),
      fixed: false,
    };
  }
}
