import type { SubtitleSelection } from '@shared/types';
import { AUTO_TRANSLATE_DELAY_MS, CLASS, MENU_GAP_PX, MENU_MARGIN_PX } from '@shared/constants';
import { sendMessage } from '@shared/messages';
import type { Settings } from '@shared/settings';
import type { DictionarySense, WordDetails } from '../providers/types';
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
  run: () => void;
}

/**
 * Inline SVG rather than emoji.
 *
 * Emoji render differently on every platform — colour, weight and baseline all shift —
 * and cannot inherit the menu's text colour, so they fought the theme in dark and light
 * alike. These are `currentColor`, so they simply match the label beside them.
 */
const ICONS: Record<string, string> = {
  translate:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  pronounce: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  save: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
};

function icon(id: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', CLASS.menuIcon);
  // Static markup from the map above; no user or provider text ever reaches here.
  svg.innerHTML = ICONS[id] ?? '';
  return svg;
}

function labelSpan(text: string): HTMLElement {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

interface MenuResult {
  state: 'loading' | 'ok' | 'error' | 'notice';
  text?: string;
  senses?: DictionarySense[];
  details?: WordDetails;
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
  /**
   * Identifies the action currently allowed to write a result.
   *
   * Provider calls take time, and a slow one finishing after the user has moved on used to
   * overwrite whatever had replaced it — a late translation landing on top of "Copied ✓",
   * or worse, appearing under a different word than the one it was asked about. Each run
   * takes a token and only writes a result while that token is still current.
   */
  private runToken = 0;
  /** Pending automatic lookup, cancelled by the next selection or by closing. */
  private autoTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.beginRun();
    this.lastTranslation = null;
    this.renderContents(selection);
    this.clearResult();
    element.removeAttribute('hidden');
    this.visible = true;
    this.position(anchor, bounds);
    this.scheduleAutoLookup(selection);
  }

  /**
   * Looks the selection up without waiting for a press (§4 — "see word, click, popup").
   *
   * Debounced, so clicking along a sentence sends one request for the word you settle on
   * rather than one per word passed through; each new selection cancels the pending one.
   *
   * Skipped entirely while online lookups are off. Firing then would put "lookups are off"
   * on screen every single time a word is selected, which is nagging rather than
   * informing — pressing Translate still explains it.
   */
  private scheduleAutoLookup(selection: SubtitleSelection): void {
    this.cancelAutoLookup();
    if (!this.settings.autoTranslate) return;
    if (this.settings.termsAcceptedAt === 0) return;

    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      void this.runDetails(selection);
    }, AUTO_TRANSLATE_DELAY_MS);
  }

  private cancelAutoLookup(): void {
    if (this.autoTimer !== null) clearTimeout(this.autoTimer);
    this.autoTimer = null;
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
    this.cancelAutoLookup();
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
    this.cancelAutoLookup();
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

    // One action, not two. Translation and definition were separate items, which meant
    // two clicks and two waits to learn what a word means — and neither told a German
    // learner the article, without which the noun cannot be used.
    actions.push({
      id: 'translate',
      label: 'Translate',
      run: () => void this.runDetails(selection),
    });

    if (this.settings.speechEnabled && isSpeechAvailable()) {
      actions.push({
        id: 'pronounce',
        label: 'Pronounce',
        run: () => void this.runPronounce(selection),
      });
    }

    actions.push({
      id: 'save',
      label: 'Save',
      run: () => void this.runSave(selection),
    });

    actions.push({
      id: 'copy',
      label: 'Copy',
      // Reported in the menu like every other action. The overlay's own "Copied ✓" flash
      // is easy to miss, and a refused clipboard write would otherwise be silent.
      run: () => {
        const token = this.beginRun();
        void this.callbacks.onCopy(selection.text).then((ok) =>
          this.setResult(
            ok
              ? { state: 'ok', text: 'Copied ✓' }
              : { state: 'error', text: 'Could not copy — the page blocked clipboard access.' },
            token,
          ),
        );
      },
    });

    return actions;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private async runDetails(selection: SubtitleSelection): Promise<void> {
    const token = this.beginRun();
    this.setResult({ state: 'loading', text: 'Looking up…' }, token);

    // The dictionary wants the headword (`geht's`, not `geht's?`); translation wants the
    // phrase as displayed (§40).
    const single = selection.words.filter((word) => word.isWordLike);
    const lookupText = single.length === 1 ? single[0]!.normalizedText : selection.text;

    const outcome = await sendMessage({
      type: 'GET_WORD_DETAILS',
      text: selection.text,
      lookupText,
      ...(selection.context ? { context: selection.context } : {}),
      ...(selection.language ? { language: selection.language } : {}),
    });

    if (!outcome) {
      this.setResult({ state: 'error', text: "Couldn't look that up. Try again." }, token);
      return;
    }
    if (!outcome.ok) {
      this.showProviderProblem(outcome, token);
      return;
    }

    this.lastTranslation = outcome.data.translation?.text ?? null;
    this.setResult({ state: 'ok', details: outcome.data }, token);
  }

  private async runPronounce(selection: SubtitleSelection): Promise<void> {
    const token = this.beginRun();
    const speakIt = (): void => {
      if (speak(selection.text, selection.language)) this.setResult({ state: 'ok', text: 'Speaking…' }, token);
      else this.setResult({ state: 'error', text: 'Could not pronounce this.' }, token);
    };

    if (this.settings.pronunciationProvider !== 'wikimedia') {
      speakIt();
      return;
    }

    this.setResult({ state: 'loading', text: 'Finding a recording…' }, token);
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
      this.setResult({ state: 'ok', text: outcome.data.title, via: 'Wikimedia' }, token);
    } catch {
      // A page Content-Security-Policy can refuse cross-origin media even to us.
      speakIt();
    }
  }

  private async runSave(selection: SubtitleSelection): Promise<void> {
    const token = this.beginRun();
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
      this.setResult({ state: 'ok', text: `Saved · ${total} ${total === 1 ? 'word' : 'words'}` }, token);
    } else {
      this.setResult({ state: 'error', text: outcome?.message ?? 'Could not save this word.' }, token);
    }
  }

  /**
   * Renders a provider failure as something actionable.
   *
   * `no-permission` is the interesting one: it means a remote provider is configured but
   * has not been approved to receive text yet, so the menu asks by name rather than
   * failing (§33).
   */
  private showProviderProblem(
    outcome: { kind: string; message: string; origin?: string },
    token?: number,
  ): void {
    // `no-permission` means lookups are off or Chrome revoked access — both fixed in
    // settings. Everything else is a service that could not answer, which is not the
    // user's to fix, so it reads as an error and offers no misleading link.
    const needsSettings = outcome.kind === 'not-configured' || outcome.kind === 'no-permission';
    this.setResult(
      {
        state: needsSettings ? 'notice' : 'error',
        text: outcome.message,
        settingsLink: needsSettings,
      },
      token,
    );
  }

  // ── Result area ─────────────────────────────────────────────────────────────

  /** Begins an action, invalidating any result still in flight from a previous one. */
  private beginRun(): number {
    return ++this.runToken;
  }

  private setResult(result: MenuResult, token?: number): void {
    const element = this.element;
    if (!element) return;
    // A superseded action has nothing useful left to say.
    if (token !== undefined && token !== this.runToken) return;

    const panel = document.createElement('div');
    panel.className = CLASS.menuResult;
    panel.dataset.ssState = result.state;
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');

    if (result.details) {
      this.renderDetails(panel, result.details);
    } else if (result.senses) {
      panel.appendChild(this.renderSenses(result.senses));
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

    // Into the slot between header and actions, so the answer appears under the word
    // rather than beneath the buttons.
    const slot = element.querySelector(`.${CLASS.menuSlot}`);
    if (slot) slot.replaceChildren(panel);
    else element.appendChild(panel);

    // The menu just changed height, so whatever placement it had is now wrong.
    this.callbacks.onResized();
  }

  private clearResult(): void {
    this.element?.querySelector(`.${CLASS.menuSlot}`)?.replaceChildren();
  }

  /**
   * The learner panel (§29, §65).
   *
   * Ordered by what someone reaching for a word actually needs: the translation, then the
   * grammar that governs how the word is used, then the meanings, then the related words.
   * Every block is skipped when its data is absent — an empty "Synonyms:" label is worse
   * than no label.
   */
  private renderDetails(panel: HTMLElement, details: WordDetails): void {
    /*
     * The article gets its own coloured chip rather than being one clause in a grey meta
     * line. `der/die/das` is the single fact a learner most needs and most often forgets,
     * and colour-coding gender is the mnemonic every German course reaches for — so it is
     * given the strongest position in the panel instead of the weakest.
     */
    if (details.article) {
      const chip = document.createElement('p');
      chip.className = CLASS.menuArticle;
      if (details.gender) chip.dataset.ssGender = details.gender;

      const article = document.createElement('span');
      article.className = CLASS.menuArticleWord;
      article.textContent = details.article;
      chip.append(article, document.createTextNode(details.headword));
      panel.appendChild(chip);
    }

    // "neuter noun · Plural: die Feuerwerke · [ˈfɔɪ̯ɐˌvɛʁk]"
    const meta: string[] = [];
    const kind = [details.gender, details.partOfSpeech?.toLowerCase()].filter(Boolean).join(' ');
    if (kind) meta.push(kind);
    if (details.plural) meta.push(`Plural: ${details.article ? 'die ' : ''}${details.plural}`);
    if (details.ipa) meta.push(`[${details.ipa}]`);

    if (meta.length > 0) {
      const line = document.createElement('p');
      line.className = CLASS.menuGrammar;
      line.textContent = meta.join(' · ');
      panel.appendChild(line);
    }

    if (details.translation) {
      const translation = document.createElement('p');
      translation.className = CLASS.menuTranslation;
      translation.textContent = details.translation.text;
      panel.appendChild(translation);
    }

    if (details.inflections) {
      panel.appendChild(
        this.renderPairs(
          Object.entries(details.inflections).map(([label, value]) => [label, value]),
        ),
      );
    }

    if (details.senses && details.senses.length > 0) {
      panel.appendChild(this.renderSenses(details.senses));
    }

    for (const [label, words] of [
      ['Synonyms', details.synonyms],
      ['Opposites', details.antonyms],
      ['Broader', details.hypernyms],
    ] as const) {
      if (!words || words.length === 0) continue;

      const row = document.createElement('div');
      row.className = CLASS.menuRelated;

      const tag = document.createElement('p');
      tag.className = CLASS.menuSectionLabel;
      tag.textContent = label;
      row.appendChild(tag);

      // Chips, not a comma list: each related word is a separate thing to take in, and a
      // run-on line of them is the hardest possible way to read a set.
      const chips = document.createElement('p');
      chips.className = CLASS.menuChips;
      for (const word of words) {
        const chip = document.createElement('span');
        chip.className = CLASS.menuChip;
        chip.textContent = word;
        chips.appendChild(chip);
      }
      row.appendChild(chips);
      panel.appendChild(row);
    }

    if (details.translation === undefined && details.problems.length > 0) {
      const note = document.createElement('p');
      note.className = CLASS.menuNote;
      note.textContent = 'No translation available.';
      panel.appendChild(note);
    }

    if (details.sources.length > 0) {
      const via = document.createElement('p');
      via.className = CLASS.menuNote;
      via.textContent = `via ${[...new Set(details.sources)].join(', ')}`;
      panel.appendChild(via);
    }
  }

  private renderSenses(senses: DictionarySense[]): HTMLElement {
    const list = document.createElement('ol');
    list.className = CLASS.menuSenses;

    for (const sense of senses.slice(0, 4)) {
      const item = document.createElement('li');
      if (sense.partOfSpeech) {
        const pos = document.createElement('span');
        pos.className = CLASS.menuPos;
        pos.textContent = sense.partOfSpeech;
        item.appendChild(pos);
      }
      item.appendChild(document.createTextNode(sense.definition));

      // One example, because seeing the word in use is worth more than a fourth gloss.
      const example = sense.examples?.[0];
      if (example) {
        const quote = document.createElement('span');
        quote.className = CLASS.menuExample;
        quote.textContent = example;
        item.appendChild(quote);
      }
      list.appendChild(item);
    }
    return list;
  }

  private renderPairs(pairs: Array<readonly [string, string]>): HTMLElement {
    const table = document.createElement('dl');
    table.className = CLASS.menuForms;
    for (const [label, value] of pairs) {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      table.append(term, detail);
    }
    return table;
  }

  /**
   * Builds the menu: header, then the answer, then the actions.
   *
   * The answer sits directly under the word rather than below the buttons. Appending
   * results after the action list buried the thing the user asked for underneath a row of
   * things they had already finished with, and pushed it off the bottom on a short player.
   */
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

    // Scroll region between header and actions, so a long definition never scrolls the
    // buttons out of reach.
    const slot = document.createElement('div');
    slot.className = CLASS.menuSlot;

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

      /*
       * Translate is why the menu opened, so it gets a full-width labelled button. The
       * rest are icon-only: three labelled buttons across a 212px panel truncate, and a
       * speaker, a bookmark and two sheets are recognisable without a caption. Both names
       * are still exposed to assistive technology and on hover.
       */
      if (action.id === 'translate') {
        button.append(icon(action.id), labelSpan(action.label));
      } else {
        button.classList.add(CLASS.menuItemCompact);
        button.title = action.label;
        button.setAttribute('aria-label', action.label);
        button.appendChild(icon(action.id));
      }
      button.addEventListener('click', (event) => {
        event.preventDefault();
        action.run();
      });
      return button;
    });

    list.append(...this.items);
    element.replaceChildren(header, slot, list);

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
