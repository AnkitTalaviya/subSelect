# SubSelect — Architecture

Written for: engineers implementing and reviewing SubSelect.

Read [FEASIBILITY.md](FEASIBILITY.md) first — this document assumes its conclusions.

---

## 1. System overview

```
┌──────────────────────────────────────── Chrome ────────────────────────────────────────┐
│                                                                                        │
│  ┌── Service worker (MV3) ──────────┐        ┌── Popup ────────┐   ┌── Options ─────┐  │
│  │  settings defaults + migration   │◄──────►│  on/off toggle  │   │  full settings │  │
│  │  message router                  │        │  languages      │   │  providers     │  │
│  │  dynamic script registration     │        │  enable-here    │   │  privacy       │  │
│  │  chrome.storage.session          │        └─────────────────┘   └────────────────┘  │
│  └──────────────▲───────────────────┘                 Phase 3                Phase 3   │
│                 │ typed runtime messages                                               │
│  ┌──────────────┴─────────────── Content script (per frame) ──────────────────────────┐│
│  │                                                                                    ││
│  │                              ┌─────────────────┐                                   ││
│  │                              │  SubtitleEngine │  lifecycle owner                  ││
│  │                              └────────┬────────┘                                   ││
│  │            ┌──────────────────────────┼──────────────────────────┐                 ││
│  │            ▼                          ▼                          ▼                 ││
│  │  ┌───────────────────┐   ┌─────────────────────┐   ┌──────────────────────┐        ││
│  │  │ActiveVideoDetector│   │  AdapterRegistry    │   │     UrlWatcher       │        ││
│  │  │ scores <video>    │   │  picks a source     │   │  SPA navigation      │        ││
│  │  └───────────────────┘   └──────────┬──────────┘   └──────────────────────┘        ││
│  │                                     ▼                                              ││
│  │                    ┌────────────────────────────────┐                              ││
│  │                    │       SubtitleAdapter          │                              ││
│  │                    │  TextTrackAdapter | GenericDom │  (+ site adapters, Phase 5)  ││
│  │                    └────────────────┬───────────────┘                              ││
│  │                                     │ raw text + timing + host element             ││
│  │                                     ▼                                              ││
│  │        ┌────────────────┐   ┌────────────────┐                                     ││
│  │        │ WordTokenizer  │──►│ SubtitleParser │  → SubtitleCue                      ││
│  │        └────────────────┘   └───────┬────────┘                                     ││
│  │                                     ▼                                              ││
│  │            ┌────────────────┐  ┌──────────────────┐  ┌──────────────────┐          ││
│  │            │PositionTracker │─►│  OverlayRenderer │─►│ SelectionManager │          ││
│  │            │ geometry+type  │  │  word spans      │  │ click/drag/esc   │          ││
│  │            └────────────────┘  └──────────────────┘  └────────┬─────────┘          ││
│  │                                                               │ SubtitleSelection  ││
│  │                                              ┌────────────────▼────────────────┐   ││
│  │                                              │  ContextMenu (Phase 3)          │   ││
│  │                                              │  → providers/ (Phase 4)         │   ││
│  │                                              └─────────────────────────────────┘   ││
│  └────────────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Key property: **everything that touches a video lives in the content script of the frame
that owns that video.** The service worker holds no engine state, because MV3 can kill it
at any moment.

---

## 2. Data flow — one subtitle, end to end

```
 player writes caption DOM          browser parses <track> cue
              │                                   │
              ▼                                   ▼
   GenericDomAdapter                      TextTrackAdapter
   MutationObserver on the                'cuechange' on the track
   caption container                      (mode forced to "hidden")
              │                                   │
              └──────────────┬────────────────────┘
                             ▼
                    raw text + optional timing + optional host element
                             ▼
                    WordTokenizer  (Intl.Segmenter, UAX #29)
                             ▼
                    SubtitleParser → SubtitleCue
                       id, text, lines[],
                       startTime?, endTime?, language?,
                       words[] with startIndex/endIndex
                             ▼
              PositionTracker  ── measures original container
                             │    (or derives a box from the video rect)
                             ▼
                    OverlayRenderer
                       writes CSS custom properties
                       emits one span per token, gaps as text nodes
                             ▼
                    SelectionManager
                       pointerdown on a word → select
                       Escape / outside click / cue change → clear
                             ▼
                    SubtitleSelection { text, words[], context, cueId, language }
                             ▼
                    SELECTION_CHANGED → service worker → chrome.storage.session
```

### Why offsets are the source of truth

`SubtitleSelection.text` is **not** built by joining word strings. It is

```ts
cue.text.slice(firstSelected.startIndex, lastSelected.endIndex)
```

after sorting the selected words by `startIndex`. This makes reverse drag (§5),
multi-line selection (§39) and punctuation preservation (§40) fall out for free, and it
guarantees that Copy reproduces exactly what was on screen.

---

## 3. Components

### `SubtitleEngine` — lifecycle owner
Single place that knows how to start, stop and restart everything. Subscribes to settings,
to `ActiveVideoDetector`, to `UrlWatcher` and to `document.visibilitychange`. Owns the
failure policy: three consecutive pipeline errors ⇒ restore the site's captions, detach,
stay off until the next navigation.

### `ActiveVideoDetector` — which `<video>` matters (§10)
Event-driven discovery via capture-phase media events plus a budgeted deep scan for
shadow roots. Scoring is a **pure function** over a `VideoMetrics` struct so it is unit
testable without a DOM:

| Signal | Score |
| --- | --- |
| playing | +50 |
| fullscreen | +100 |
| visible (≥10% intersecting) | +30 |
| large (≥25% of viewport) | +20 |
| audible (not muted, volume > 0) | +20 |
| centred | +10 |
| tiny (< 200×120) | −30 |
| hidden / zero-size / `display:none` | −100 |
| decorative (muted + loop + autoplay) | −50 |

Highest score above 0 wins; ties break toward the larger element. Re-scores on media
events, fullscreen change and intersection change — never on a timer once bound.

### `AdapterRegistry` — layered detection (§63)
Adapters are tried in priority order and the first that reports `canHandle()` wins:

```
site adapters (Phase 5)  →  GenericDomAdapter  →  TextTrackAdapter  →  none
        ↑ only when generic detection provably fails on that site
```

`GenericDomAdapter` outranks `TextTrackAdapter` because mirrored geometry beats
reconstructed geometry. If neither handles the video, the engine reports
`NO_SUBTITLE_SOURCE` and does nothing else.

### `GenericDomAdapter` — find the caption container without hardcoding class names
Candidates are gathered with a deliberately broad selector net and then scored:

1. **Content** *(required)* — holds non-empty text, under ~700 characters, and contains no
   nested `video`/`canvas`/`iframe`.
2. **Geometry** *(required)* — overlaps the video by at least half its own box, sits in
   its lower portion, is no wider than the frame.
3. **Semantics** — `[role="region"]` with a caption-ish `aria-label`, or `[aria-live]`.
   Highest-scoring signal and the most stable across redesigns.
4. **Naming hints** — `caption`, `subtitle`, `timedtext`, `untertitel`, `cue`,
   `shaka-text` in `class`/`id`/`data-*`. Ranks lower than semantics.

Content plus geometry is **necessary but not sufficient**: a watermark, a title card and a
"now playing" strip are indistinguishable on those two alone. A candidate must therefore
also carry at least one *declared* signal — 3 or 4. Either one suffices, so a CSS rename
degrades the ranking rather than breaking detection; a player offering neither is a case
for a Phase 5 site adapter, not a guess.

When the chosen container is later replaced by a **different element**, the adapter calls
`AdapterContext.invalidate()` and the engine rebuilds the binding. The overlay's mount
parent and measurement target are read once at bind time, so swapping them underneath the
renderer would silently desynchronise the overlay from the player.

### `TextTrackAdapter` — `<track>` / programmatic tracks
Picks the track the user chose (`mode === "showing"`), switches it to `"hidden"`, and
renders it ourselves. Records the previous mode and **always restores it on detach**.
Follows `addtrack` / `removetrack`. Reads `VTTCue.line/position/align` to place the box.

### `WordTokenizer` + `SubtitleParser` (§12, §13, §40)
`Intl.Segmenter` → merge hyphen/apostrophe runs → attach adjacent edge punctuation →
emit tokens carrying `text`, `normalizedText`, `lookupKey`, `startIndex`, `endIndex`,
`isWordLike`, `lineIndex`. `SubtitleParser` wraps this into a `SubtitleCue` and assigns a
content-stable cue id so an unchanged caption does not cause a re-render.

### `PositionTracker` (§38)
Produces a `SubtitleBox` — `x, y, width, height, fontSize, lineHeight, fontFamily,
fontWeight, color, textShadow, letterSpacing, textAlign` — relative to the mount
container. Sources:

* **DOM path** — `getBoundingClientRect()` + `getComputedStyle()` of the original.
* **TextTrack path** — derived from the video rect; font size scales with video height
  (`clamp` around ~4.5% of height), position from the cue's `line`/`align`.

Recomputes on: cue change, `ResizeObserver` (player + original), `fullscreenchange`,
window resize, and a **bounded** 10-frame `requestAnimationFrame` burst after any of
those, to settle CSS transitions. Never a standing rAF loop.

### `OverlayRenderer` (§7, §41)
Light-DOM layer mounted as a sibling of the caption container (or of the video), styled
entirely by manifest-declared CSS driven by CSS custom properties. One `<span>` per token;
raw inter-token text is emitted as plain text nodes so spacing is byte-exact. Word spans
get `pointer-events: auto`; everything else stays `pointer-events: none` so player
controls keep working (§43).

Highlight readability over arbitrary video (§41) uses a translucent accent fill plus a
contrasting inset outline, so it reads on both bright and dark scenes without changing the
caption's own colour.

### `SelectionManager` (§4, §5, §6, §23, §43, §44)
Owns the gesture; mirrors the result to the native selection.

**Why that order.** The brief wants selection that feels native (§6) but warns against
depending on it, because players render captions in ways that defeat normal DOM selection.
So `pointerdown` is cancelled, the pointer is captured on the pressed word, and each move
resolves to a word by geometry (`hitTest.pickWordAtPoint`). That is word-granular, survives
an ancestor with `user-select: none`, and cannot run away into the surrounding page.

Once the gesture ends, `window.getSelection()` is pointed at exactly the selected spans.
That mirror is **load-bearing, not decoration**: a `copy` event only fires when the
document has a selection, so it is what makes `Ctrl`/`Cmd`+`C`, right-click → Copy and
assistive technology work at all. Its own highlight is hidden inside the layer, because
`::selection` can set a background and a colour but not the contrasting edge our highlight
needs over arbitrary video.

Copy text never comes from the native range — a range spanning two caption lines
stringifies with a newline, and §39 wants one phrase — so `selectionTextFor` slices the cue
by offset instead.

Two details worth knowing:

* **Double-press is detected by hand.** Cancelling `pointerdown` suppresses the
  compatibility mouse events; the Pointer Events spec guarantees `click`, `auxclick` and
  `contextmenu` still fire but says nothing about `dblclick`. The press record carries the
  *cue id* as well as the word id, because word ids are offset-derived — `w0-3` is the
  first word of every caption.
* **Word rects are read once per drag**, not per move, keeping a forced layout off the
  pointermove path. A cue change mid-drag invalidates them and aborts the gesture.

Clears on Escape, outside click, cue change, video change and teardown. Stops propagation
on word hits only, so clicking a caption never pauses the video while clicking anywhere
else still does.

### `ContextMenu` (§16, §47)
Mounted inside the player container, like the overlay, so it survives fullscreen for free.
The cost is that a player with `overflow: hidden` can clip it, which is why
`menuPlacement.placeMenu` keeps it inside the video box and prefers *above* the caption —
where the room is, and where it does not cover the picture.

It **does not take focus** when it opens: pulling focus out of the player would break
space-to-pause and arrow-key seeking, which §43 forbids. It is reachable by Tab, and arrow
keys move between items once focus is inside.

Only working actions appear. Pronounce (browser speech synthesis) and Copy are there;
Translate, Dictionary and Save arrive with their providers in Phase 4.

> The top-layer `popover` API would escape `overflow` clipping as well as fullscreen, but
> needs Chrome 114 against our current floor of 109, and re-shows on every fullscreen
> transition. Worth revisiting if clipping shows up in real testing.

### Fullscreen re-parenting (§37)
Only the fullscreen element's subtree renders, so an overlay outside it vanishes. Normally
the player container goes fullscreen and our layer is already inside it. When it is not,
`SubtitleEngine.onFullscreenChange` moves the layer and menu into the fullscreen element
and restores them on exit.

A bare `<video>` going fullscreen is the one case with no answer: its children are fallback
content and never render, so nothing can be drawn over it. The overlay stands down for the
duration rather than pretending to work.

### `UrlWatcher` (§36)
`popstate` + `hashchange` + a throttled `MutationObserver` on `<title>` and
`documentElement`, comparing `location.href`. On change: full teardown, then re-attach.

---

## 4. Interfaces

```ts
// ── Cue model (§11) ──────────────────────────────────────────────────────────
interface SubtitleWord {
  id: string;
  text: string;            // original slice, punctuation kept:  "geht's?"
  normalizedText: string;  // edge punctuation stripped:         "geht's"
  lookupKey: string;       // locale-lowercased normalizedText:  "geht's"
  startIndex: number;      // offset into SubtitleCue.text
  endIndex: number;        // exclusive
  isWordLike: boolean;     // false for punctuation-only tokens
  lineIndex: number;
  boundingRect?: Rect;     // filled by OverlayRenderer after layout
}

interface SubtitleCue {
  id: string;
  text: string;            // lines joined with "\n"
  lines: string[];
  startTime?: number;
  endTime?: number;        // → §30/§31 replay, stored but unused in Phase 1
  language?: string;
  words: SubtitleWord[];
  source: 'dom' | 'texttrack';
}

// ── Selection (§14) ──────────────────────────────────────────────────────────
interface SubtitleSelection {
  id: string;
  text: string;            // cue.text.slice(first.startIndex, last.endIndex)
  words: SubtitleWord[];
  cueId?: string;
  language?: string;
  context?: string;        // the whole cue (§15)
  startTime?: number;
  endTime?: number;
}

// ── Adapter (§35) ────────────────────────────────────────────────────────────
interface AdapterContext {
  video: HTMLVideoElement;
  playerRoot: HTMLElement;
  language?: string;
  /** Adapter → engine: "my presentation changed, rebuild the binding." */
  invalidate: () => void;
}

interface SubtitleAdapter {
  readonly id: string;
  canHandle(ctx: AdapterContext): boolean;
  attach(ctx: AdapterContext): void;
  detectSubtitles(): SubtitleCue[];
  getCurrentCue(): SubtitleCue | null;
  observeChanges(cb: (cue: SubtitleCue | null) => void): () => void;
  getPresentation(): AdapterPresentation | null;   // where/how to draw
  detach(): void;
}
```

`attach`/`detach`/`getPresentation` extend the brief's §35 interface. They are required
because an adapter owns real resources (observers, a forced `track.mode`) that must be
released deterministically, and because the renderer needs to know whether geometry is
*mirrored* from a DOM node or *derived* from the video box.

`boundingRect` is typed `Rect` (a DOMRect-shaped plain object) rather than `DOMRect` so a
cue stays structured-cloneable for messaging. A real `DOMRect` satisfies `Rect`
structurally, so assignment is unchanged.

### Providers (§17, §18, §26)

`src/providers/types.ts` holds the contracts; implementations sit beside it and are chosen
by `createTranslationProvider` / `createDictionaryProvider` from settings. The selection
engine never imports a provider, so it cannot couple to one vendor. `AIProvider` is still
a declaration only — Phase 6.

**Provider calls run in the service worker**, not the content script, for three reasons:
`fetch` there is governed by host permissions instead of the page's CORS policy; an API key
never has to exist in a tab's process; and the page cannot observe that a lookup happened.

**Two gates in front of every remote call** (§33), both required:

1. the Chrome host permission for that origin, and
2. the host appearing in `settings.consentedHosts` — the user's own recorded agreement
   that this host may receive selected text.

They are granted together on the options page, which is the only context that can call
`chrome.permissions.request`; a content script cannot, so the menu routes "Open settings"
through the worker instead. The origin is derived from the configured endpoint rather than
assumed to be `https://<host>`, because a self-hosted LibreTranslate is commonly plain
`http` on a local port.

**No undocumented endpoints.** Pointing the extension at a search engine's internal
translate URL would give free translation with no key; it is also fragile, outside the
terms those endpoints are offered under, and a good way to get an extension pulled from
the Web Store. Providers are on-device, open-source services with documented APIs, or an
API the user configured with their own credentials.

Where the open-source options sit:

| Need | Default | Open-source options |
| --- | --- | --- |
| Translation | not set up | **LibreTranslate** (AGPL, self-hostable, fully open pipeline) · **Lingva** (MIT, but a Google Translate proxy) |
| Dictionary | not set up | **Wiktionary** (CC BY-SA) · **Free Dictionary API** (MIT) |
| Pronunciation | speech synthesis | **Wikimedia / Lingua Libre** recordings (CC BY-SA / CC0) |

`Lingva` is labelled honestly in the UI: the project is open source, the translation it
returns is Google's, and the terms question belongs to whoever runs the instance. It is
offered because it works with no signup; LibreTranslate is the recommendation.

**Pronunciation ranks candidates rather than taking the first file.** A Wiktionary page
carries maps, portraits and icons alongside recordings, and one API call returns them all.
`scoreRecording` rejects non-audio and wrong-word files outright, then ranks by language
convention (`De-Berlin.ogg`, `LL-Q188 (deu)-Speaker-Berlin.wav`). Closeness is judged on
the **last hyphen-separated segment only** — everything before it is metadata, and scoring
the whole filename would penalise Lingua Libre for embedding a speaker name, which is
exactly backwards since those are the best recordings available.

**§18 is taken literally**: there is no built-in word list and no heuristic fallback.
Either a provider returns definitions or the UI says lookup is not configured. A
plausible-looking guess is worse than nothing for someone learning the language.

### Vocabulary (§19–§22)

`chrome.storage.local`, one array under one key — the list is small, and one key means
read, write and export are each a single operation with no partially-written state.
Entries deduplicate on the normalized word plus source language, so `Berlin.` and `Berlin`
do not become two rows.

Export runs in the dashboard page because a content script cannot start a download; a blob
URL from an extension page can. CSV fields are RFC 4180 quoted **and** guarded against
formula injection — subtitle text is not ours to trust, and a leading `=` executes in
Excel and Sheets.

---

## 5. Messaging (§55)

```ts
type ExtensionMessage =
  | { type: 'GET_FRAME_STATUS' }                                      // popup  → content
  | { type: 'SELECTION_CHANGED'; selection: SubtitleSelection | null }; // content → worker
```

Every message is a discriminated union member with a typed response (`MessageResponseMap`
pairs the two), routed through one `sendMessage<T>()` helper. No string-keyed, untyped
message passing anywhere.

The union is deliberately small. **Settings are not messages.** Every context reads
`chrome.storage.local` directly and `chrome.storage.onChanged` broadcasts a write to all
of them at once, which leaves exactly one code path into applying a settings change rather
than two that can drift apart. Messaging is reserved for what storage cannot express:
asking a specific frame's engine what it currently sees, and handing a selection to the
worker for the popup to display.

It grows with each new surface — Phase 3's keyboard commands, Phase 4's provider calls
(which must run in the worker, not in a page's frame).

---

## 6. Permissions (§51)

| Permission | Why | Install warning |
| --- | --- | --- |
| `storage` | settings + vocabulary, local only | none |
| `scripting` | register content scripts for user-approved origins | none |
| `activeTab` | one-off "try it on this page" from the toolbar | none |
| `content_scripts.matches` (known video sites) | run automatically where video is expected | per-site |
| `optional_host_permissions: *://*/*` | user-granted, per-site, on request | only when requested |

Deliberately **not** requested: `tabs`, `webRequest`, `declarativeNetRequest`, `cookies`,
`history`, `<all_urls>` at install time. The extension never reads a URL it was not
injected into.

---

## 7. Folder structure

```
selectSubtitle/
├── docs/
│   ├── FEASIBILITY.md          platform limits, what is and isn't possible
│   ├── ARCHITECTURE.md         this file
│   └── COMPATIBILITY.md        test matrix — measured, never assumed
├── public/
│   ├── manifest.json
│   ├── content.css             CSP-exempt styling for the overlay
│   └── icons/
├── scripts/
│   ├── build.mjs               three IIFE/HTML bundles via the Vite API
│   └── generate-icons.mjs      dependency-free PNG generation
├── src/
│   ├── background/service-worker.ts
│   ├── content/
│   │   ├── index.ts            entry: guards, then boots the engine
│   │   ├── SubtitleEngine.ts
│   │   ├── ActiveVideoDetector.ts
│   │   ├── SubtitleParser.ts
│   │   ├── WordTokenizer.ts
│   │   ├── SelectionManager.ts
│   │   ├── hitTest.ts          pure point → word resolution for dragging
│   │   ├── ContextMenu.ts      the menu next to a selection
│   │   ├── menuPlacement.ts    pure placement geometry
│   │   ├── speech.ts           Pronounce, via browser speech synthesis
│   │   ├── OverlayRenderer.ts
│   │   ├── PositionTracker.ts
│   │   ├── UrlWatcher.ts
│   │   ├── dom.ts              shadow-aware, budgeted DOM helpers
│   │   └── adapters/
│   │       ├── types.ts
│   │       ├── AdapterRegistry.ts
│   │       ├── GenericDomAdapter.ts
│   │       └── TextTrackAdapter.ts
│   ├── providers/types.ts      Phase 4 seams — types only
│   ├── popup/
│   ├── shared/
│   │   ├── types.ts  messages.ts  constants.ts
│   │   ├── settings.ts  storage.ts  text.ts  logger.ts
│   └── vocabulary/             Phase 4
└── tests/
```

---

## 8. Roadmap

| Phase | Scope | State |
| --- | --- | --- |
| 1 — Core engine | MV3 shell, active-video detection, DOM + TextTrack sources, cue model, tokenizer, overlay, click-to-select, highlight | done |
| 2 — Selection | drag select, native `getSelection()` mirror, multi-line, reverse, double-press, copy | done |
| 3 — UI | context menu, options page, keyboard shortcut, fullscreen re-parenting, themes, pronunciation | done |
| **4 — Language tools** | translation + dictionary providers, vocabulary store, dashboard, CSV/JSON export | **this delivery** |
| 5 — Site compatibility | measure the matrix; add site adapters **only** where generic detection provably fails | next |
| 6 — Advanced learning | AI + local-LLM providers, pronunciation, replay segment, flashcards, Anki export | |

Phases 2–6 are **not** stubbed with placeholder implementations. The seams they need
(adapter registry, provider types, timing on the cue, `SubtitleSelection.context`) exist;
the behaviour does not.

---

## 9. Known limitations

Carried forward from FEASIBILITY.md so they are visible at review time:

* Captions in a **closed shadow root** — unreachable.
* **Bitmap / canvas / burned-in** subtitles — no text exists; unsupported permanently.
* **Picture-in-Picture** — no overlay is possible in the PiP window.
* **Cross-origin iframes** — handled by injecting into the frame; an embed that we have no
  content-script match for is invisible to us.
* **Page CSP vs. inline style attributes** — confined to `PositionTracker.apply` and
  flagged **[VERIFY]**; all static styling already goes through manifest-declared CSS.
* **Players that re-render captions every frame** would cause overlay churn; the renderer
  diffs on a content hash and skips identical cues, but a pathological player may still
  cost more than it should.
* **Per-site support is unverified.** `docs/COMPATIBILITY.md` starts as all-unknown by
  design (§60).
