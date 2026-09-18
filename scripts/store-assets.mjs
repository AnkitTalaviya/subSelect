/**
 * Captures the Chrome Web Store listing assets from the real extension.
 *
 * Everything here is a genuine screenshot of SubSelect running: the overlay, the panel and
 * its contents come from the built extension talking to the real free services. Two
 * concessions, both about the harness rather than the product:
 *
 *  - A copy of dist/ is used with the provider origins moved into `host_permissions`.
 *    The shipped extension asks for them at runtime on the welcome screen, and a native
 *    permission prompt cannot be answered in headless — so the grant is declared instead.
 *    The code, the UI and the data are unchanged.
 *  - The video is a neutral generated picture (test-page/demo.html). No real service is
 *    imitated and no third-party footage or branding appears.
 *
 * Output: store/*.jpg at the store's required sizes, JPEG so there is no alpha channel.
 *
 * `store/` is deliberately not tracked — the listing copy and its assets stay off GitHub —
 * so the two promo-tile sources it renders, store/promo-small.html and
 * store/promo-marquee.html, live only in a working copy.
 */
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist');
const SHOTS = resolve(ROOT, 'dist-store');
const OUT = resolve(ROOT, 'store');
const PAGES = resolve(ROOT, 'test-page');
const CERT = join(tmpdir(), 'subselect-dev.pfx');
const PORT = 8741;
const BROWSER =
  process.env.SUBSELECT_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const PROVIDER_ORIGINS = [
  'https://api.mymemory.translated.net/*',
  'https://lingva.ml/*',
  'https://*.wiktionary.org/*',
  'https://api.dictionaryapi.dev/*',
];

if (!existsSync(DIST)) {
  console.error('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(CERT)) {
  console.error('certificate missing — run `npm run verify:browser` once to create it.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
rmSync(SHOTS, { recursive: true, force: true });
cpSync(DIST, SHOTS, { recursive: true });
{
  const manifest = JSON.parse(readFileSync(join(SHOTS, 'manifest.json'), 'utf8'));
  manifest.host_permissions = PROVIDER_ORIGINS;
  writeFileSync(join(SHOTS, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(
  { pfx: readFileSync(CERT), passphrase: 'subselect' },
  async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = join(PAGES, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  },
);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'subselect-store-'));
const browser = spawn(
  BROWSER,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${SHOTS}`,
    '--remote-debugging-port=9333',
    `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--mute-audio',
    '--headless=new',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtools(path) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:9333${path}`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`devtools ${path} unavailable`);
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 25000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function newTab(url) {
  const target = await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  }).then((r) => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, id: target.id };
}

async function shoot(cdp, name, { width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(500);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 92,
    clip: { x: 0, y: 0, width, height, scale: 1 },
    captureBeyondViewport: true,
  });
  writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(shot.data, 'base64'));
  console.log(`  ${name}.jpg  ${width}x${height}`);
}

/** Clicks the word whose text matches, and waits for the panel to settle. */
async function clickWord(cdp, text) {
  const spot = JSON.parse(
    await cdp.eval(`(()=>{const w=[...document.querySelectorAll('.subselect-word')]
      .find(x=>x.textContent.replace(/[^\\p{L}\\p{N}'’-]/gu,'') === ${JSON.stringify(text)});
      if(!w) return JSON.stringify({found:false});
      const r=w.getBoundingClientRect();
      return JSON.stringify({found:true,x:r.x+r.width/2,y:r.y+r.height/2})})()`),
  );
  if (!spot.found) throw new Error(`no word "${text}" on screen`);

  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
    await sleep(70);
  }
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const state = await cdp.eval(
      `document.querySelector('.subselect-menu-result')?.dataset.ssState ?? ''`,
    );
    if (state && state !== 'loading') return state;
  }
  return '';
}

try {
  console.log('browser:', (await devtools('/json/version')).Browser);
  await sleep(2500);

  const worker = (await devtools('/json/list')).find(
    (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'),
  );
  const extensionId = worker ? new URL(worker.url).host : null;
  if (!extensionId) throw new Error('extension service worker not found');
  console.log('extension:', extensionId);

  const sw = new CDP(worker.webSocketDebuggerUrl);
  await sw.ready;
  await sw.send('Runtime.enable');
  await sw.eval(
    `chrome.storage.local.get('settings').then(s => chrome.storage.local.set({
       settings: { ...(s.settings ?? {}), termsAcceptedAt: Date.now(), autoTranslate: true,
                   subtitleLanguage: 'de', translationLanguage: 'en' },
     })).then(() => 'ok')`,
  );
  sw.close();
  await sleep(600);

  console.log('\ncapturing screenshots…');
  const { cdp } = await newTab('https://www.youtube.com/demo.html');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: 'https://www.youtube.com/demo.html' });
  await sleep(4000);

  // 1 — a noun: article, plural, pronunciation, translation.
  await cdp.eval(`window.__demo.setCaption('Wir sehen uns heute Abend das Feuerwerk an.'); 1`);
  await sleep(900);
  console.log('  panel state:', await clickWord(cdp, 'Feuerwerk'));
  await shoot(cdp, 'screenshot-1-word', { width: 1280, height: 800 });

  // 2 — a verb: the forms a learner is taught.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  // The infinitive, so the panel shows the full set of forms rather than one participle.
  await cdp.eval(`window.__demo.setCaption('Ich muss mich heute endlich entscheiden.'); 1`);
  await sleep(900);
  console.log('  panel state:', await clickWord(cdp, 'entscheiden'));
  await shoot(cdp, 'screenshot-2-verb', { width: 1280, height: 800 });

  // 3 — a phrase, selected by dragging.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  await cdp.eval(`window.__demo.setCaption('Ich habe mich für einen neuen Job entschieden.'); 1`);
  await sleep(900);
  const drag = JSON.parse(
    await cdp.eval(`(()=>{const w=[...document.querySelectorAll('.subselect-word')];
      const pick=(t)=>w.find(x=>x.textContent.replace(/[^\\p{L}\\p{N}'’-]/gu,'')===t);
      const a=pick('für'), b=pick('Job');
      if(!a||!b) return JSON.stringify({found:false});
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return JSON.stringify({found:true,ax:ra.x+ra.width/2,ay:ra.y+ra.height/2,
        bx:rb.x+rb.width/2,by:rb.y+rb.height/2})})()`),
  );
  if (drag.found) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.ax, y: drag.ay, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left', buttons: 1,
        x: drag.ax + ((drag.bx - drag.ax) * i) / 8,
        y: drag.ay + ((drag.by - drag.ay) * i) / 8,
      });
      await sleep(40);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.bx, y: drag.by, button: 'left', buttons: 0 });
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      const state = await cdp.eval(`document.querySelector('.subselect-menu-result')?.dataset.ssState ?? ''`);
      if (state && state !== 'loading') break;
    }
  }
  await shoot(cdp, 'screenshot-3-phrase', { width: 1280, height: 800 });

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  cdp.close();

  // 4 — the vocabulary list.
  const vocab = await newTab(`chrome-extension://${extensionId}/vocabulary.html`);
  // JSON.stringify once: twice would store the array as a string, and the manager
  // correctly rejects anything that is not an array.
  await vocab.cdp.eval(`chrome.storage.local.set({ vocabulary: ${JSON.stringify(
    ([
      { id: '1', word: 'entscheiden', normalizedWord: 'entscheiden', translation: 'to decide, to make a decision', context: 'Ich muss mich heute endlich entscheiden.', sourceLanguage: 'de', targetLanguage: 'en', website: 'example.com', createdAt: Date.now() - 1000 },
      { id: '2', word: 'Feuerwerk', normalizedWord: 'Feuerwerk', translation: 'fireworks', context: 'Wir sehen uns heute Abend das Feuerwerk an.', sourceLanguage: 'de', targetLanguage: 'en', website: 'example.com', createdAt: Date.now() - 90000 },
      { id: '3', word: 'allerdings', normalizedWord: 'allerdings', translation: 'however, though', context: 'Das ist allerdings schwierig.', sourceLanguage: 'de', targetLanguage: 'en', website: 'example.com', createdAt: Date.now() - 400000 },
      { id: '4', word: 'Größe', normalizedWord: 'Größe', translation: 'size, dimension', context: 'Welche Größe brauchst du?', sourceLanguage: 'de', targetLanguage: 'en', website: 'example.com', createdAt: Date.now() - 900000 },
      { id: '5', word: 'obwohl', normalizedWord: 'obwohl', translation: 'although, even though', context: 'Obwohl ich müde bin, lerne ich Deutsch.', sourceLanguage: 'de', targetLanguage: 'en', website: 'example.com', createdAt: Date.now() - 1500000 },
    ]),
  )} }).then(()=>location.reload()); 1`);
  await sleep(1600);
  await shoot(vocab.cdp, 'screenshot-4-vocabulary', { width: 1280, height: 800 });
  vocab.cdp.close();

  // 5 — settings, showing the free providers and the privacy position.
  const options = await newTab(`chrome-extension://${extensionId}/options.html`);
  await sleep(1500);
  await shoot(options.cdp, 'screenshot-5-settings', { width: 1280, height: 800 });
  options.cdp.close();

  console.log('\ncapturing promo tiles…');
  for (const [name, size] of [
    ['promo-small', { width: 440, height: 280 }],
    ['promo-marquee', { width: 1400, height: 560 }],
  ]) {
    const tile = await newTab(`file:///${resolve(OUT, `${name}.html`).replace(/\\/g, '/')}`);
    await sleep(1200);
    await shoot(tile.cdp, name, size);
    tile.cdp.close();
  }

  console.log(`\nassets written to store/`);
} catch (err) {
  console.error('\nCAPTURE ERROR:', err.message);
  process.exitCode = 1;
} finally {
  browser.kill();
  server.close();
}
