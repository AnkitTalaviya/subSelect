# SubSelect — Feasibility & Platform Constraints

Written for: engineers implementing and reviewing SubSelect.

This document answers §68 of the product brief **before** any product code is written.
It records what a Chrome MV3 extension can and cannot legitimately do with subtitles,
which constraints shape the architecture, and which claims still need on-site verification.

Every statement is tagged:

| Tag | Meaning |
| --- | --- |
| **[SPEC]** | Guaranteed by a web platform / Chrome extension specification. |
| **[KNOWN]** | Well-established behaviour of current Chrome, relied on by shipping extensions. |
| **[VERIFY]** | Plausible but **not yet verified on the live site**. Must be confirmed before it is claimed anywhere user-facing. |

Nothing in this document describes circumventing DRM, decrypting protected media,
intercepting encrypted streams, or bypassing browser security. See
[§9 Hard boundaries](#9-hard-boundaries-non-negotiable).

---

## 1. How websites actually put subtitles on screen

There are exactly five delivery mechanisms that matter, and they have very different
accessibility from a content script.

### 1.1 Browser-rendered `<track>` cues — **accessible (data), not accessible (pixels)**

```html
<video>
  <track kind="subtitles" src="de.vtt" srclang="de" default>
</video>
```

The browser parses the WebVTT and renders the cues itself, inside a **closed
user-agent shadow tree**.

* `video.textTracks` → `TextTrackList`; each `TextTrack` has `.cues`, `.activeCues`,
  `.language`, `.kind`, `.mode`, and fires `cuechange`. **[SPEC]**
* `VTTCue` exposes `.text`, `.startTime`, `.endTime`, `.line`, `.position`, `.align`. **[SPEC]**
* The rendered caption boxes are **not reachable** via `querySelector`. `::cue` can style
  them from CSS but gives no DOM nodes. **[SPEC]**
* `track.mode = "hidden"` keeps cues parsed and `cuechange` firing while stopping
  UA rendering. **[SPEC]**
* `track.mode = "disabled"` may drop `.cues` entirely. **[SPEC]**

**Consequence:** for this source we get perfect *text and timing* but zero *layout*.
The only way to make it interactive is to switch the track to `hidden` and render the
caption ourselves. That is a legitimate, documented API use — we render the same text
the browser was about to render.

**Cross-origin caveat:** a `<track src>` on a different origin needs CORS +
`crossorigin` on the `<video>`, otherwise the browser never populates `.cues`. We do not
fetch the file ourselves — if the page could not load it, neither can we, and we do not
try. **[SPEC]**

### 1.2 Player-rendered DOM captions — **accessible**

Most commercial players ship their own caption renderer and write real text nodes into
the page, because they need positioning, styling and ruby/bidi control the UA does not offer.

```html
<div class="player-timedtext">
  <div class="player-timedtext-text-container">
    <span>Ich möchte morgen nach Berlin fahren.</span>
  </div>
</div>
```

This is ordinary page DOM. A content script shares the DOM with the page **[SPEC]**, so it
can read the text, measure it with `getBoundingClientRect()`, and observe it with
`MutationObserver`. This is the richest source: text **and** exact on-screen geometry.

This is the dominant mechanism on YouTube, Netflix, Prime Video, Disney+, Hotstar,
Twitch, Vimeo and every shaka-player / video.js / hls.js deployment. **[KNOWN]**

### 1.3 Captions inside an **open** shadow root — **accessible with effort**

`host.shadowRoot` is readable when the root was created `{mode:'open'}` **[SPEC]**.
Two practical costs:

* `document.querySelectorAll` does **not** pierce shadow boundaries. **[SPEC]**
* A `MutationObserver` on `document` does **not** observe inside a shadow root; each root
  needs its own observer. **[SPEC]**

So shadow support means an explicit, budgeted tree walk plus per-root observers.

### 1.4 Captions inside a **closed** shadow root — **not accessible**

`host.shadowRoot` is `null`, `event.composedPath()` is truncated at the boundary, and the
isolated world gives no privileged access. **[SPEC]** Not supported; detect and report.

### 1.5 Bitmap / canvas-rendered subtitles — **not accessible**

* DVB/PGS image subtitles shipped inside the stream.
* ASS/SSA rendered to `<canvas>` (SubtitlesOctopus, JASSUB).
* Burned-in ("hardcoded") subtitles.

There is no text. Recovering it would require OCR of decoded video frames, which for a
protected stream also means touching decrypted content. **Out of scope, permanently.**
Detect and show the §34 message.

---

## 2. What a content script can reach

| Capability | Status | Notes |
| --- | --- | --- |
| Page DOM (read + write) | ✅ **[SPEC]** | Shared with the page. |
| `video.textTracks`, `cuechange` | ✅ **[SPEC]** | Same DOM objects as the page's. |
| `getComputedStyle`, `getBoundingClientRect` | ✅ **[SPEC]** | Basis for mirroring caption typography. |
| `MutationObserver` / `ResizeObserver` / `IntersectionObserver` | ✅ **[SPEC]** | Our only sanctioned change signals. |
| Page JS globals (`window.netflix`, `ytplayer`, `videojs`) | ❌ **[SPEC]** | Isolated world. Requires a `world:"MAIN"` script. **SubSelect Phase 1–5 does not use MAIN world.** |
| Open shadow roots | ✅ **[SPEC]** | Per-root traversal + observation. |
| Closed shadow roots | ❌ **[SPEC]** | — |
| Cross-origin iframe DOM from the parent frame | ❌ **[SPEC]** | Must inject into the frame instead. |
| `chrome.storage.*`, `chrome.runtime` messaging | ✅ **[SPEC]** | — |
| EME / MediaKeys / decrypted buffers | ⛔ **Forbidden by policy** | See §9. |

### 2.1 Why we avoid the MAIN world

Running in `world: "MAIN"` would let us read player internals (Netflix's cue list,
YouTube's `timedtext` response). It also means our code executes with the page's
privileges, is visible to the page, can be tampered with by the page, and is subject to
the page's CSP. It materially increases both the security surface and the review burden
for the Chrome Web Store listing. Everything Phase 1–5 needs is available from the DOM
and the TextTrack API, so the MAIN world stays unused. If a future adapter genuinely
requires it, it must be a per-site, user-visible opt-in with its own review.

---

## 3. Iframes (§62)

**Finding:** the parent frame can never read a cross-origin child frame's DOM **[SPEC]**.
There is no extension permission that changes this — `all_frames` does not grant
cross-document access, it grants *injection into each document*.

**Therefore the architecture must be frame-local:** the full engine (detector → parser →
overlay → selection) runs independently inside whichever frame owns the `<video>`, and
renders its overlay in that same frame. Nothing needs to cross the boundary.

Consequences:

* `"all_frames": true` is required. **[SPEC]**
* Each frame runs its own engine instance. Idle cost in a frame with no video must be
  near zero (see §7).
* Fullscreen from inside an iframe requires the embed to carry `allow="fullscreen"`;
  that is the site's choice, not ours. **[SPEC]**
* Cross-frame coordination (e.g. "which frame holds the real player") goes through the
  service worker with `sender.frameId`, never through DOM access. **[SPEC]**
* `about:blank` / `srcdoc` frames inherit the parent origin and would need
  `match_about_blank`. Not enabled in Phase 1. **[SPEC]**

Practical impact: Vimeo/Twitch/YouTube **embeds** on third-party pages run inside
`player.vimeo.com` / `player.twitch.tv` / `www.youtube.com` iframes, so the extension must
have a content script match for those origins, not just for the embedding site. **[KNOWN]**

---

## 4. Rendering strategy: native selection vs. overlay (§6, §7)

### 4.1 The problem with mutating the player's own caption DOM

The obvious idea — wrap each word of the player's existing caption text node in a
`<span>` — gives perfect positioning for free, and native `window.getSelection()` works
immediately.

It is also the single most dangerous thing we could do. Commercial players are React or
similar; if the framework later calls `parent.removeChild(textNode)` on a text node we
already replaced, it throws `NotFoundError` **inside the player's render loop**. That can
break caption rendering or playback, which violates the brief's mandatory §58
("the video must continue playing normally").

**Decision: SubSelect does not restructure the player's DOM.** In-place tokenization is
kept behind an off-by-default experimental flag, never enabled for an unknown site.

### 4.2 What we do instead — mirror overlay

```
player container (position: relative)
├── <video>
├── player's caption container      ← we add ONE attribute: data-subselect-hidden
│     (visibility: hidden, layout preserved so we can keep measuring it)
└── .subselect-layer                ← our sibling overlay, same geometry,
      └── word spans                  typography copied via getComputedStyle
```

Adding an attribute is a safe mutation: it changes no children, so no reconciliation can
fail. If the framework strips the attribute on re-render, we re-apply it (we are already
observing that node).

`visibility: hidden` rather than `display: none` is deliberate — the original keeps its
box, so it stays measurable and the overlay tracks it for free through every layout
change the player makes.

### 4.3 Native selection is preserved

The overlay is rendered into the **light DOM**, not a shadow root, specifically so that
`window.getSelection()` and `Range` work normally across the word spans (§6). Selection
APIs across shadow boundaries are awkward and partly non-standard, and Phase 2 depends on
drag selection feeling native.

Cost: page CSS can bleed into our layer. Mitigated by a strict, prefixed reset in
manifest-declared CSS (see §5.2). The context popup (Phase 3) has no selection
requirement and *will* use a closed-off shadow root.

### 4.4 Two render paths, one renderer

| Source | Geometry comes from | Original hidden by |
| --- | --- | --- |
| Player DOM captions (§1.2/§1.3) | measuring the original container | `data-subselect-hidden` attribute |
| `<track>` cues (§1.1) | computed from the video rect + `VTTCue.line/position/align` | `track.mode = "hidden"` |

Both feed the same `SubtitleCue` and the same `OverlayRenderer`. The DOM path is strongly
preferred when both are available, because mirrored geometry is always more faithful than
reconstructed geometry.

---

## 5. Chrome platform constraints

### 5.1 Manifest V3

* Background is a **service worker** — it is killed when idle and has no DOM. **[SPEC]**
  ⇒ no engine state may live there. It holds routing and `chrome.storage.session` only.
* Content scripts are **classic scripts, not ES modules**. **[SPEC]**
  ⇒ the content bundle must be built as a single IIFE.
* `chrome.scripting.registerContentScripts` persists dynamic registrations across
  browser restarts. **[SPEC]** ⇒ this is how user-granted sites keep working.
* `activeTab` grants temporary host access to the current tab after a user gesture on the
  extension action. **[SPEC]** ⇒ "try it here" with zero install-time warnings.

### 5.2 Page CSP vs. our styling

* CSS declared in `content_scripts[].css` or injected via `chrome.scripting.insertCSS`
  is **not** subject to the page's CSP. **[KNOWN]** ⇒ all our static styling goes there.
* Whether a page's `style-src` can block **inline style attributes set by a content
  script** is the one item here that must be confirmed empirically on a strict-CSP site.
  **[VERIFY]**

Mitigation designed in from the start: all dynamic values are written as a small number
of **CSS custom properties** (`--ss-x`, `--ss-font-size`, …) on the layer root, and the
manifest-declared stylesheet consumes them. If the property write ever proved to be
blocked, the fix is confined to one function (`PositionTracker.apply`), not scattered
across the renderer.

### 5.3 Fullscreen (§37)

When an element enters fullscreen, **only that element's subtree renders**. **[SPEC]**
⇒ an overlay mounted on `document.body` disappears in fullscreen. Ours is mounted inside
the player container, which is normally the element that goes fullscreen, so it survives.

Defensive rule: on `fullscreenchange`, if `document.fullscreenElement` exists and does not
contain our layer, re-parent the layer into it.

`HTMLElement.showPopover()` places an element in the **top layer**, above fullscreen
content **[SPEC]** — the right primitive for the Phase 3 context popup. Chrome 114+.

### 5.4 Picture-in-Picture

The PiP window renders decoded video frames only; DOM captions do not appear there and
no overlay can be drawn into it. **[SPEC]** Not supported — detect and stand down.

---

## 6. Detecting the right video (§9, §10)

`document.querySelectorAll('video')` routinely returns ads, autoplay previews, hero-banner
loops and hidden preload elements. We score instead of guessing.

Two things make this cheap:

* **Capture-phase media events.** Media events (`play`, `playing`, `loadedmetadata`,
  `emptied`, …) do not bubble, but a **capture-phase** listener on `document` still sees
  them because capture runs from the root down to the target. **[SPEC]** This gives
  event-driven discovery with no polling.
* **`IntersectionObserver`** supplies visibility without measuring in a loop. **[SPEC]**

Limitation: media events are **not composed**, so they do not cross a shadow boundary.
**[SPEC]** A `<video>` inside a shadow root is therefore found by the (budgeted) deep scan
rather than by its events. A `<video>` inside a *closed* root cannot be found at all.

---

## 7. Performance envelope (§56)

Hard rules the implementation must respect:

1. No `setInterval` faster than 1000 ms, ever. The only timer in Phase 1 is a
   discovery retry that **stops permanently once a video is bound**.
2. `MutationObserver` on `document` is allowed only in the pre-attach phase, is throttled
   to a trailing 250 ms, and is replaced by a narrow observer on the caption container as
   soon as one is identified.
3. `requestAnimationFrame` only in **bounded bursts** (N frames after a change event),
   never as a standing loop.
4. Everything unsubscribes when: the feature is toggled off, the document becomes
   hidden, no active video is bound, or the frame has no `<video>` at all.
5. A frame with no video must settle to **zero timers and one idle observer** within a
   few seconds of load. This is the cost paid on every page the extension matches, so it
   is the number to watch.

---

## 8. Language & text handling (§12, §13, §40)

`Intl.Segmenter` with `granularity: "word"` implements Unicode UAX #29 and is available in
Chrome 87+ and Node 16+. **[SPEC]** It is the correct primitive and replaces all regex
splitting:

* German umlauts and `ß` are ordinary letters — no special casing needed, provided we
  never `toUpperCase()` (`ß` → `SS` is lossy) and normalize to **NFC** only in the
  lookup key, never in the source text (normalizing would invalidate character offsets).
* **Compound words** (`Arbeitslosenversicherung`) contain no word boundary, so UAX #29
  returns them whole. Correct by construction — the failure mode would have been a
  hand-rolled splitter.
* **Apostrophes**: `'` (U+0027) and `’` (U+2019) are UAX #29 *MidLetter*, so `geht's`
  segments as one word. **[SPEC]**
* **Hyphens** are *not* MidLetter, so `Kfz-Versicherung` segments as three pieces. This
  needs an explicit merge pass. **[SPEC]**

Punctuation is handled by keeping two representations per token (§40): `text` preserves
the original (`geht's?`), `normalizedText` strips edge punctuation (`geht's`).

**Copy fidelity comes from offsets, not from re-joining tokens.** Every word carries
`startIndex`/`endIndex` into the cue text, so a multi-word selection is
`cue.text.slice(first.startIndex, last.endIndex)` — byte-exact, including whatever
punctuation and spacing sat between the words. This also makes reverse and multi-line
selection trivially correct.

---

## 9. Hard boundaries (non-negotiable)

SubSelect will never:

* extract, derive or handle DRM keys;
* call, wrap, patch or observe EME / `MediaKeys` / `MediaKeySession`;
* intercept, proxy or parse encrypted media segments;
* patch `fetch`/`XMLHttpRequest` to capture subtitle network responses;
* download or persist subtitle files or video;
* OCR video frames to recover burned-in or bitmap subtitles;
* bypass CORS, CSP, the same-origin policy, or any site restriction;
* send subtitle text anywhere without an explicit, per-action user request.

**The extension only ever reads subtitle text that the page has already rendered into the
DOM, or that the browser has already parsed into a `TextTrack`.** Both are exposed to the
page by the site's own player, through documented web APIs.

Where a player's subtitles are not reachable that way, the correct behaviour is to show

```
Interactive subtitles aren't available for this player.
```

and stop. No fallback, no workaround.

---

## 10. Per-site expectations

**None of these are tested yet.** They are predictions used to prioritise work, and they
are recorded here so that `docs/COMPATIBILITY.md` can be filled in with measurements
rather than optimism. See §60 of the brief — nothing ships as "working" without a test.

| Site | Predicted mechanism | Predicted path | Confidence |
| --- | --- | --- | --- |
| Generic HTML5 + `<track>` | UA-rendered VTT | TextTrack | **[KNOWN]** high |
| video.js / hls.js / shaka | player DOM | Generic DOM | **[KNOWN]** high |
| YouTube | player DOM (own renderer, not `<track>`) | Generic DOM | **[VERIFY]** high |
| Vimeo | `<track>` + own DOM renderer; **embeds are iframes** | Generic DOM, in-frame | **[VERIFY]** med-high |
| Netflix | player DOM text nodes | Generic DOM | **[VERIFY]** medium |
| Prime Video | player DOM text nodes | Generic DOM | **[VERIFY]** medium |
| Disney+ / Hotstar | shaka-style DOM text container | Generic DOM | **[VERIFY]** medium |
| Twitch | DOM CC container when CC enabled | Generic DOM | **[VERIFY]** medium |
| Max / Apple TV+ / Plex | player DOM | Generic DOM | **[VERIFY]** low-medium |
| Any bitmap/PGS/burned-in track | pixels only | **unsupported** | **[SPEC]** certain |

Anything a site does inside a closed shadow root, or renders to canvas, is unsupported
regardless of which site it is.

---

## 11. Conclusions that shape the architecture

1. **Two sources, one model.** DOM captions and TextTrack cues normalise into the same
   `SubtitleCue`. Everything downstream is source-agnostic.
2. **Never restructure the player's DOM.** One attribute is the entire write budget on
   third-party nodes.
3. **Mirror overlay in light DOM** — faithful geometry *and* native selection.
4. **Frame-local engine.** Iframes are solved by injection, never by cross-frame access.
5. **Event-driven only.** Capture-phase media events, `MutationObserver`,
   `ResizeObserver`, `IntersectionObserver`. No polling loops.
6. **Offsets, not string joins.** Character offsets into the cue text are the source of
   truth for selection and copy.
7. **Fail open, never fail loud.** Any uncaught error restores the site's own captions and
   detaches. The video's behaviour is never affected.
8. **Minimum permissions.** No `host_permissions` at install; content-script matches for
   known video sites, `activeTab` for one-off use, optional origins for opt-in sites.
