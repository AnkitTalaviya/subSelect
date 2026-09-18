# SubSelect — Compatibility Matrix

Written for: engineers and testers verifying SubSelect against real sites.

**Nothing here is marked working until someone has actually watched a video on that site
with this build loaded.** Per §60 of the brief, predictions are not results. The
predictions live in [FEASIBILITY.md §10](FEASIBILITY.md#10-per-site-expectations); this
file records measurements only.

Legend: `✓` verified working · `✗` verified broken · `—` not applicable ·
`?` **not tested**

## Status at Phase 4

Verified rows come from `npm run verify:browser`, which loads `dist/` into a real Chromium
and drives it over the DevTools Protocol. Everything else is still untested.

| Site | Video found | Subtitle source | Cue text | Overlay aligns | Click | Drag | Copy | Menu | Fullscreen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test page — DOM captions | ✓ | ✓ dom | ✓ | ✓ 0px | ✓ | ✓ | ✓ | ✓ | ? |
| Test page — TextTrack cues | ✓ | ✓ texttrack | ✓ | ✓ derived | ✓ | ✓ | ✓ | ✓ | ? |
| Test page — YouTube-style auto captions | ✓ | ✓ dom | ✓ | ✓ 0px | ✓ | ✓ | ✓ | ✓ | ? |
| Generic HTML5 (video.js / hls.js) | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| YouTube | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Netflix | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Amazon Prime Video | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Disney+ | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| JioHotstar / Hotstar | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Twitch | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Vimeo (on vimeo.com) | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Vimeo (embedded iframe) | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Crunchyroll | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Max | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Apple TV+ | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Plex | ? | ? | ? | ? | ? | ? | ? | ? | ? |

What the automated run asserts, on both subtitle sources: the overlay renders; it aligns
with the player's caption to the pixel (mirror mode) or lands in the lower video (derived
mode); the site's own caption is suppressed so text is never doubled; a click selects
exactly one word without pausing the video; a drag selects a phrase; the menu opens with
all five actions; a caption change clears the highlight but leaves the menu usable; and
Escape clears both.

Copy and fullscreen are not automated — the clipboard and the fullscreen transition both
need a real user gesture that the protocol cannot fake convincingly.

### Running it

```bash
npm run build
npm run verify:browser [dom-captions.html|texttrack.html]
```

It uses **Edge**, not Chrome: branded Chrome stable refuses to side-load an unpacked
extension. Point `SUBSELECT_BROWSER` at any other Chromium to override. A screenshot lands
at `verify.png` — look at it, an assertion passing on a blank frame proves nothing.

`SUBSELECT_HEADFUL=1` runs in a real window, which is the only way to test the tab-switch
case: headless reports every page as visible however targets are activated. Keep the rest
of the suite headless — in a real window Chrome's occlusion detection can mark the window
hidden, which correctly pauses the health check and makes the recovery checks flaky.

## How to test a site

1. Load the unpacked build (`README.md` → Install).
2. Open a video on the site and **turn the site's own subtitles on**. SubSelect never
   enables captions for you.
3. Open DevTools on the page and run `localStorage.SUBSELECT_DEBUG = '1'`, then reload.
   The content script logs its detection decisions under the `[SubSelect]` prefix.
4. Record, per column:
   * **Video found** — log line `active video bound`, with a plausible size.
   * **Subtitle source** — `dom` or `texttrack`; `none` means no source was found.
   * **Cue text** — the logged cue text matches what is on screen, character for
     character, including umlauts and `ß`.
   * **Overlay aligns** — our words sit exactly on the original glyphs at default size,
     at 200% browser zoom, in theater mode and in fullscreen.
   * **Typography unchanged** — the caption is the same size, family and weight with
     SubSelect on as with it off. SubSelect is a language tool, not a caption-size tool; it
     copies the player's typography and must never impose its own. Check this with a
     **two-line** caption in particular, which is where the font is easiest to read off the
     wrong element.
   * **Click** — clicking a word highlights exactly that word and does **not**
     pause/play the video.
   * **Drag** — dragging selects the whole phrase, in both directions, and across both
     caption lines; the player's seek bar and volume are unaffected while dragging.
   * **Copy** — `Ctrl`/`Cmd`+`C` and right-click → Copy both yield exactly the highlighted
     text, with a caption line break rendered as one space and no extension text added.
   * **Menu** — appears next to the selection without covering it, stays inside the player
     (check especially in fullscreen and near the top of the frame), and clicking Copy
     does not pause the video.
   * **Fullscreen** — overlay and menu both stay visible. If they do not, record which
     element the site actually makes fullscreen (`document.fullscreenElement` in the
     console) — that is what the re-parenting rule needs to know.
5. If a column is `✗`, file it with: site, URL pattern, browser version, the
   `[SubSelect]` log, and a DOM snapshot of the caption container.

## Known-unsupported by design

These are not bugs and must not be filed as such — see
[FEASIBILITY.md §9](FEASIBILITY.md#9-hard-boundaries-non-negotiable).

| Case | Reason |
| --- | --- |
| Bitmap / PGS / DVB image subtitles | no text exists, only pixels |
| Burned-in ("hardcoded") subtitles | part of the video image |
| ASS/SSA rendered to `<canvas>` | no DOM text nodes |
| Captions inside a closed shadow root | not reachable from any extension world |
| Picture-in-Picture window | cannot host an overlay |
| A bare `<video>` element put into fullscreen | its children are fallback content and never render, so nothing can be drawn over it |
| A player in an iframe origin we have no match for | no content script runs there |

In every one of these cases the correct user-facing behaviour is the §34 message —
*"Interactive subtitles aren't available for this player."* — and nothing else.
