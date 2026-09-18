# SubSelect

**Make the subtitles on online videos clickable, selectable and useful.**

You are watching a German film. A word goes by that you don't know:

```
Ich habe mich gestern für einen neuen Job entschieden.
                                             ↑ click
```

SubSelect selects that word in place, over the video, without pausing anything:

```
Ich habe mich gestern für einen neuen Job [entschieden].
```

Later phases turn that selection into a translation, a definition, a saved vocabulary
entry. The first release is about getting the hard part right: making subtitle text on
someone else's video player behave like real, selectable text.

SubSelect is a standalone Chrome extension. It is not related to, and shares no code
with, any video zoom, stretch, crop or aspect-ratio extension.

---

## Status — Phase 4 of 6

| | |
| --- | --- |
| **Working** | active-video detection · DOM caption source · `<track>` / TextTrack source · cue model · Unicode word tokenization · overlay that mirrors the player's caption box · click, drag and double-click selection · copy · context menu · settings page · keyboard shortcut · fullscreen handling · themes · **translation providers** · **dictionary lookup** · **saved vocabulary + dashboard** · **CSV / JSON export** |
| **Next (Phase 5)** | measure the site matrix; add site adapters only where generic detection provably fails |
| **Later** | AI / local LLM · replay · flashcards · Anki export |

### Providers

It works out of the box. On first install a welcome page names every service SubSelect can
contact and asks once; accept and translation, definitions and recordings are ready with
no keys, no accounts and no per-source setup. Decline and everything except lookups still
works, with no network access at all.

**Providers are tried in a chain, not fixed.** Whichever answers first is used, so a
service that is rate limited, down, or simply missing a word or language pair is a pause
rather than a dead end. Each answer is labelled with where it came from, and if every
provider fails you see what each one said.

| | Order tried |
| --- | --- |
| Translation | on-device (if the browser has it) → MyMemory → Lingva |
| Definitions | Wiktionary → Free Dictionary API |
| Pronunciation | Wikimedia recording → speech synthesis |

Any single provider can still be pinned in Settings, including LibreTranslate or DeepL
with your own key.

| Translation | Licence | Needs | Sends text off device |
| --- | --- | --- | --- |
| Not set up *(default)* | — | — | No |
| On-device (Chrome built-in) | — | Recent Chrome | **No** — runs locally |
| [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) | AGPL-3.0 | Instance URL | Yes |
| [Lingva Translate](https://github.com/thedaviddelta/lingva-translate) | MIT | Instance URL, no key | Yes |
| DeepL | proprietary | API key | Yes |
| Custom endpoint | — | URL | Yes |

**LibreTranslate is the recommendation** — it is open source end to end (Argos Translate
models, self-hostable, no third party in the loop). **Lingva** is an open-source front end
that scrapes Google Translate, the same idea as Invidious for YouTube: no signup and good
quality, but the translation still comes from Google and the terms question belongs to
whoever runs the instance. Both are volunteer-hosted; settings suggests instances and
self-hosting is the only way to be sure one stays up.

There is deliberately **no bundled "free" translation** hitting a search engine's internal
endpoint directly. Those are undocumented, outside the terms they are offered under, and a
good way to get an extension pulled from the Web Store.

| Dictionary | Licence | Needs | Sends text off device |
| --- | --- | --- | --- |
| Not set up *(default)* | — | — | No |
| [Wiktionary](https://en.wiktionary.org) | CC BY-SA | Nothing — no key | Yes |
| [Free Dictionary API](https://github.com/meetDeveloper/freeDictionaryAPI) | MIT | Nothing — no key | Yes |
| Custom endpoint | — | URL | Yes |

| Pronunciation | Licence | Needs | Sends text off device |
| --- | --- | --- | --- |
| Speech synthesis *(default)* | — | — | No — the browser reads it |
| [Wikimedia recordings](https://lingualibre.org) | CC BY-SA / CC0 | Nothing — no key | Yes |

**Wikimedia recordings are real human voices**, not synthesis — Wiktionary audio and
[Lingua Libre](https://lingualibre.org), the Wikimedia project where native speakers record
their own languages. For a learner that is categorically better than TTS, which routinely
gets German vowel length and final devoicing wrong. When no recording exists for a word,
it falls back to speech synthesis automatically.

A custom endpoint is a few lines to shim:

```
POST  { "text": "…", "source": "de", "target": "en", "context": "…" }
→     { "translation": "…" }
```

### Interactions

| Gesture | Result |
| --- | --- |
| Click a word | Selects it and opens the menu |
| Click it again | Clears the selection |
| Drag across words | Selects the phrase — any direction, across both caption lines |
| Double-click | Selects the whole caption |
| `Ctrl`/`Cmd` + `C` | Copies exactly the selected text, nothing else |
| `Esc` | Closes the menu and clears the selection |
| `Alt` + `Shift` + `S` | Turns interactive subtitles on and off |

The menu offers **Translate**, **Definition**, **Pronounce**, **Save** and **Copy**.
Translate and Definition say plainly when no provider is set up rather than inventing an
answer; Save and Copy always work, with no provider and no network.

The shortcut defaults to `Alt+Shift+S`, not the brief's `Alt+S`. Extension commands
intercept the key before the page sees it, so plain `Alt+S` would silently break any site
that uses it. Rebind it at `chrome://extensions/shortcuts`.

Both subtitle sources are **verified end to end in a real browser** by
`npm run verify:browser` — overlay alignment, click, drag, menu, caption changes and
Escape. Per-site support beyond the test pages is still unmeasured;
[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) records measurements, not predictions.

Read before contributing:

* [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md) — what a Chrome extension can and cannot do
  with subtitles, and the platform limits that shaped the design.
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data flow, interfaces, roadmap.
* [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — the test matrix and how to fill it in.

---

## Install (unpacked)

```bash
npm install
npm run build
```

Then in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `dist/` folder

From a packaged zip instead (`npm run package`): unzip it first, then **Load unpacked** on
the unzipped folder. Chrome's *Load unpacked* takes a directory, not an archive — dragging
a `.zip` onto the extensions page does not work for unpacked development builds.

Scripts:

| Command | Does |
| --- | --- |
| `npm run build` | icons + three bundles into `dist/` |
| `npm run package` | build, then zip `dist/` to `subselect-<version>.zip` for sharing or Web Store upload |
| `npm run dev` | same as build, in watch mode |
| `npm test` | unit tests (Vitest) |
| `npm run verify:browser` | loads `dist/` into a real Chromium and drives it — click, drag, menu, Escape |
| `npm run typecheck` | `tsc --noEmit` over the extension and the build config |
| `npm run check` | typecheck + tests |

## Try it

The repo ships two synthetic players so Phase 1 can be verified without depending on any
third-party site:

```
test-page/index.html
├── dom-captions.html   player-rendered DOM captions  → GenericDomAdapter
└── texttrack.html      browser-rendered VTT cues     → TextTrackAdapter
```

Open one, wait for a caption, and click a word. It should highlight instantly, and the
video must keep playing. Then drag across several words — including from the second line
back up to the first, and right to left — and press `Ctrl`/`Cmd`+`C`. The clipboard should
hold exactly the highlighted phrase, with the caption's line break rendered as a single
space. Also try fullscreen, 200% zoom, and switching the page's captions off and on.

Over `file://` these pages need **Allow access to file URLs** enabled for SubSelect on
`chrome://extensions`. Otherwise serve the folder over HTTP and use **Enable on this
site** in the popup.

For detection logs: `localStorage.SUBSELECT_DEBUG = '1'` in the page console, then reload.

---

## Permissions

SubSelect requests **no host permissions at install time**. Every permission below is
listed with the single thing it is for.

| Permission | What it is for |
| --- | --- |
| `storage` | Settings, on this device. Phase 4 adds the vocabulary list, also on this device. |
| `activeTab` | Lets you try SubSelect on a page that is not in the list below, from the toolbar button. Temporary, and only after you click. |
| `scripting` | Starts SubSelect on a site you explicitly enabled, and keeps it working there after a reload. |
| `optional_host_permissions: *://*/*` | **Not granted at install.** Only ever requested one origin at a time, when you press *Enable on this site*. |

Content scripts run automatically only on sites where a video player is expected:
YouTube, Netflix, Prime Video, Disney+, Hotstar/JioHotstar, Twitch, Vimeo, Crunchyroll,
Max, Apple TV+, Plex, and `file://` pages (which additionally require the Chrome file-access
toggle). Anywhere else, nothing runs until you ask it to.

Deliberately **not** requested: `tabs`, `webRequest`, `declarativeNetRequest`, `cookies`,
`history`, `downloads`, or `<all_urls>` at install time.

## Privacy

SubSelect reads subtitle text that the page has **already put on screen** — either in the
page's DOM, or parsed by the browser into a `TextTrack`. Nothing else.

It does not, and will not:

* record, download or re-stream video;
* download or store subtitle files;
* touch DRM, EME, `MediaKeys`, or any encrypted stream;
* intercept network requests;
* read your browsing history or track what you watch;
* send subtitle text anywhere on its own.

Two gates stand in front of every request and both must be open: your acceptance on the
welcome screen, and the Chrome host permission granted with it. Revoking the site access
in Chrome stops everything regardless of the setting, and one switch in Settings turns
lookups off again.

Once on, the selected text and its subtitle line are sent to a provider **only** when you
press Translate, Definition or Pronounce — never in the background, never on a timer,
never for text you did not select. Every answer is labelled with where it came from.

Declining is a first-class option: selection, copy and save need no network whatsoever.

API keys are stored in this browser's local storage and sent only to the endpoint you
entered them for. They never leave with an export.

Two caveats worth stating plainly:

- **Speech synthesis.** Chrome exposes both offline (OS) voices and Google's network
  voices. SubSelect always prefers an offline voice for the subtitle language; where none
  exists the browser falls back to an online voice, which means that word is sent to Google
  to be spoken. The menu says so at the moment it applies, and Pronounce can be turned off.
- **Wikimedia recordings** are off by default and, once approved, send the selected word to
  the relevant Wiktionary to find a recording.

Where a player's subtitles cannot be reached legitimately, SubSelect says so and stops:

```
Interactive subtitles aren't available for this player.
```

That includes bitmap and burned-in subtitles, captions rendered to `<canvas>`, and
captions inside a closed shadow root. There is no workaround for these and SubSelect does
not look for one. See [`docs/FEASIBILITY.md` §9](docs/FEASIBILITY.md#9-hard-boundaries-non-negotiable).

## Safety

The video always wins. If anything in SubSelect fails, it restores the site's own
captions, detaches from the player and stays out of the way. It never pauses, seeks,
re-sources or restyles the video, and it never restructures the player's DOM — the only
thing it ever writes to a site's element is one attribute.

---

## Layout

```
src/
├── background/service-worker.ts   routing, defaults, dynamic script registration
├── content/
│   ├── index.ts                   per-frame entry
│   ├── SubtitleEngine.ts          lifecycle owner; the only thing that starts/stops work
│   ├── ActiveVideoDetector.ts     scores <video> elements (§10)
│   ├── SubtitleParser.ts          cue model + selection text from offsets
│   ├── WordTokenizer.ts           Intl.Segmenter / UAX #29 tokenization
│   ├── OverlayRenderer.ts         the interaction layer
│   ├── PositionTracker.ts         geometry + typography mirroring
│   ├── SelectionManager.ts        pointer/keyboard input → SubtitleSelection
│   ├── hitTest.ts                 pure point → word resolution for dragging
│   ├── ContextMenu.ts             the menu next to a selection
│   ├── menuPlacement.ts           pure placement geometry
│   ├── speech.ts                  Pronounce, via browser speech synthesis
│   ├── UrlWatcher.ts              SPA navigation
│   ├── dom.ts                     shadow-aware, budgeted DOM helpers
│   └── adapters/                  TextTrack + generic DOM sources, registry
├── providers/
│   ├── types.ts                   provider contracts + error/result envelopes
│   ├── url.ts                     host/origin helpers, HTML stripping
│   ├── translation/providers.ts   on-device, LibreTranslate, Lingva, DeepL, custom
│   ├── dictionary/providers.ts    Wiktionary, Free Dictionary API, custom
│   └── pronunciation/providers.ts Wikimedia / Lingua Libre recordings
├── vocabulary/
│   ├── VocabularyManager.ts       local store, dedupe, search, sort
│   ├── VocabularyExporter.ts      CSV / JSON, generated on device
│   └── vocabulary.*               the dashboard page
├── popup/                         on/off, language, saved count, page status
├── options/                       full settings page
└── shared/                        types, messages, settings, storage, text, constants
```

## License

MIT — see [LICENSE](LICENSE).
