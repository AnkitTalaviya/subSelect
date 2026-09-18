/**
 * End-to-end check: loads dist/ into a real Chromium and drives it over the DevTools
 * Protocol. Run with `npm run verify:browser [page.html]`.
 *
 * Three things about the setup are load-bearing, and each cost a debugging round:
 *
 *  - **Edge, not Chrome.** Branded Chrome stable refuses to side-load an unpacked
 *    extension — it logs "--disable-extensions-except is not allowed in Google Chrome"
 *    and ignores --load-extension with it. Edge is the same Chromium with the same
 *    extension APIs, so the code under test is identical. Chrome for Testing would also
 *    work if you have it.
 *  - **HTTPS, not HTTP.** The page is served over TLS because youtube.com is in Chromium's
 *    HSTS preload list: an http:// URL is upgraded before any request leaves the browser,
 *    so a plain server is never contacted.
 *  - **A mapped host, not localhost.** --host-resolver-rules points www.youtube.com at the
 *    local server so the SHIPPED manifest's content_scripts match with no edit. Testing a
 *    doctored manifest would not tell us much.
 *
 * The self-signed certificate is generated on first run via PowerShell and reused after.
 */
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist');
const PAGES = resolve(ROOT, 'test-page');
const CERT = join(tmpdir(), 'subselect-dev.pfx');
const PORT = 8731;
const BROWSER =
  process.env.SUBSELECT_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = process.argv[2] ?? 'dom-captions.html';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

if (!existsSync(DIST)) {
  console.error('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}

if (!existsSync(CERT)) {
  console.log('generating a self-signed certificate…');
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `$c = New-SelfSignedCertificate -DnsName "www.youtube.com" -CertStoreLocation "cert:\\CurrentUser\\My" -NotAfter (Get-Date).AddDays(30);` +
      `Export-PfxCertificate -Cert $c -FilePath "${CERT}" -Password (ConvertTo-SecureString -String "subselect" -Force -AsPlainText) | Out-Null;` +
      `Remove-Item "cert:\\CurrentUser\\My\\$($c.Thumbprint)" -Force`,
  ]);
}

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

const profile = mkdtempSync(join(tmpdir(), 'subselect-run-'));
const browser = spawn(
  BROWSER,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${DIST}`,
    '--remote-debugging-port=9222',
    `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    '--mute-audio',
    // Headless reports every page as visible however targets are activated, so the
    // tab-switch check needs a real window: SUBSELECT_HEADFUL=1.
    ...(process.env.SUBSELECT_HEADFUL ? [] : ['--headless=new']),
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtools(path) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:9222${path}`);
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
    this.logs = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.logs.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
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
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

try {
  console.log('browser:', (await devtools('/json/version')).Browser);
  await sleep(2500);

  /*
   * Turn lookups on from inside the extension.
   *
   * The welcome screen's permission prompt cannot be answered in headless, so consent is
   * written straight to storage. The Chrome host permission is still absent, so providers
   * are refused at the second gate — which is fine here: what this verifies is that a
   * lookup is *attempted* on selection, not that a remote service answers.
   */
  const worker = (await devtools('/json/list')).find(
    (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'),
  );
  if (worker) {
    const sw = new CDP(worker.webSocketDebuggerUrl);
    await sw.ready;
    await sw.send('Runtime.enable');
    await sw.eval(
      `chrome.storage.local.get('settings').then(s => chrome.storage.local.set({
         settings: { ...(s.settings ?? {}), termsAcceptedAt: Date.now(), autoTranslate: true },
       })).then(() => 'ok')`,
    );
    sw.ws.close();
    await sleep(600);
  }
  check('extension service worker running', Boolean(worker));

  const page = (await devtools('/json/list')).find((t) => t.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Headless defaults to a small window; use a desktop-sized viewport so the geometry
  // being checked is the geometry a real viewer gets.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  /*
   * Record the page's own interval ids before any page script runs.
   *
   * The freeze used to be `clearInterval(1..5000)`, which is far too blunt: a content
   * script's timers live in the same window timer table as the page's, so that was also
   * cancelling the extension's — including the health check whose recovery this file is
   * meant to verify. Only ids the page itself created are cleared now.
   */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const ids = [];
      window.__ssPageTimers = ids;
      const original = window.setInterval;
      window.setInterval = function (...args) {
        const id = original.apply(this, args);
        ids.push(id);
        return id;
      };
    })();`,
  });

  console.log(`\nnavigating to https://www.youtube.com/${PAGE}\n`);
  await cdp.send('Page.navigate', { url: `https://www.youtube.com/${PAGE}` });
  await sleep(3500);

  check('page served over the mapped host', (await cdp.eval('location.host')) === 'www.youtube.com');
  check('page video playing', await cdp.eval('(()=>{const v=document.querySelector("video");return !!v&&!v.paused&&v.readyState>=2})()'));

  let words = 0;
  for (let i = 0; i < 30; i++) {
    words = await cdp.eval('document.querySelectorAll(".subselect-word").length');
    if (words > 0) break;
    await sleep(500);
  }
  check('SubSelect overlay rendered', words > 0, `${words} clickable words`);

  if (words > 0) {
    // Freeze the caption carousel so the remaining assertions are not racing a cue change.
    await cdp.eval('(window.__ssPageTimers ?? []).forEach(clearInterval); "frozen"');
    await sleep(400);
    console.log('   cue:', await cdp.eval('document.querySelector(".subselect-layer").textContent.trim()'));

    const mirrored = Boolean(await cdp.eval('!!document.querySelector(\'[data-subselect-hidden="true"]\')'));
    console.log('   mode:', mirrored ? 'mirror (DOM captions)' : 'derived (TextTrack)');

    if (mirrored) {
      // Does the overlay sit exactly on top of the player's own caption?
      const align = JSON.parse(
        await cdp.eval(`(()=>{
          const orig=document.querySelector('[data-subselect-hidden="true"]').getBoundingClientRect();
          const layer=document.querySelector('.subselect-layer').getBoundingClientRect();
          const vid=document.querySelector('video').getBoundingClientRect();
          const r=o=>({x:Math.round(o.x),y:Math.round(o.y),w:Math.round(o.width),h:Math.round(o.height)});
          return JSON.stringify({orig:r(orig),layer:r(layer),video:r(vid),
            dx:Math.round(layer.x-orig.x),dy:Math.round(layer.y-orig.y)})})()`),
      );
      console.log('   video :', JSON.stringify(align.video));
      console.log('   orig  :', JSON.stringify(align.orig));
      console.log('   layer :', JSON.stringify(align.layer), `offset dx=${align.dx} dy=${align.dy}`);
      check('overlay aligns with the original caption', Math.abs(align.dx) <= 2 && Math.abs(align.dy) <= 2,
        `dx=${align.dx} dy=${align.dy}`);
    } else {
      // TextTrack path: the browser's own rendering must be switched off, and the derived
      // caption box must land inside the lower part of the video.
      check('text track switched to hidden (no doubled text)',
        (await cdp.eval('document.querySelector("video").textTracks[0].mode')) === 'hidden');
      const box = JSON.parse(
        await cdp.eval(`(()=>{const l=document.querySelector('.subselect-layer').getBoundingClientRect();
          const v=document.querySelector('video').getBoundingClientRect();
          return JSON.stringify({inside: l.left>=v.left-1 && l.right<=v.right+1 && l.bottom<=v.bottom+1,
            lower: (l.top - v.top) / v.height})})()`),
      );
      check('derived caption box sits inside the lower video', box.inside && box.lower > 0.4,
        `top at ${Math.round(box.lower * 100)}% of the video`);
    }

    const box = JSON.parse(
      await cdp.eval(`(()=>{const w=document.querySelectorAll('.subselect-word');
        const el=w[Math.min(2,w.length-1)];const r=el.getBoundingClientRect();
        return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,text:el.textContent})})()`),
    );
    console.log(`\n   clicking "${box.text}" at ${Math.round(box.x)},${Math.round(box.y)}`);

    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(80);
    }
    await sleep(1000);

    const selected = await cdp.eval(
      'document.querySelectorAll(\'.subselect-word[data-ss-selected="true"]\').length',
    );
    check('click selects the word', selected === 1, `${selected} highlighted`);

    // Selecting a word pauses so it can be read; clearing it hands playback back.
    check('video pauses while a word is selected',
      await cdp.eval('document.querySelector("video").paused'));

    // Selecting a word should look it up on its own, with no button pressed.
    let auto = '';
    for (let i = 0; i < 20; i++) {
      auto = await cdp.eval(
        `(()=>{const p=document.querySelector('.subselect-menu-result');
          return p ? (p.dataset.ssState + ': ' + p.textContent.trim().slice(0,60)) : ''})()`,
      );
      if (auto && !auto.startsWith('loading')) break;
      await sleep(400);
    }
    check('selection triggers a lookup with no button press', Boolean(auto), auto || 'no panel appeared');
    // Playback resumes only because SubSelect paused it in the first place.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(600);
    check('video resumes when the selection is cleared',
      await cdp.eval('!document.querySelector("video").paused'));

    /*
     * A video the viewer paused must stay paused. Resuming it would take playback off the
     * person watching, which is the one thing this feature must never do.
     */
    await cdp.eval('document.querySelector("video").pause(); 1');
    await sleep(300);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(60);
    }
    await sleep(400);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(600);
    check('a video the viewer paused is left alone',
      await cdp.eval('document.querySelector("video").paused'));

    // Back to playing for the checks that follow.
    await cdp.eval('document.querySelector("video").play(); 1');
    await sleep(400);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(60);
    }
    await sleep(500);

    const menu = JSON.parse(
      await cdp.eval(`(()=>{const m=document.querySelector('.subselect-menu');
        if(!m) return JSON.stringify({present:false});
        const r=m.getBoundingClientRect();
        return JSON.stringify({present:true,hidden:m.hasAttribute('hidden'),
          w:Math.round(r.width),h:Math.round(r.height),
          term:m.querySelector('.subselect-menu-term')?.textContent,
          items:[...m.querySelectorAll('.subselect-menu-item')].map(b=>b.textContent.trim())})})()`),
    );
    check('context menu opens', menu.present && !menu.hidden,
      menu.present ? `${menu.w}x${menu.h} "${menu.term}" [${(menu.items ?? []).join(', ')}]` : 'absent');

    // Drag from the first word to the fourth.
    const drag = JSON.parse(
      await cdp.eval(`(()=>{const w=document.querySelectorAll('.subselect-word');
        const a=w[0].getBoundingClientRect(),b=w[Math.min(3,w.length-1)].getBoundingClientRect();
        const ax=a.x+a.width/2, ay=a.y+a.height/2;
        const hit=document.elementFromPoint(ax,ay);
        const menu=document.querySelector('.subselect-menu');
        const mr=menu?menu.getBoundingClientRect():null;
        return JSON.stringify({ax,ay,bx:b.x+b.width/2,by:b.y+b.height/2,
          startWord:w[0].textContent,
          hitAtStart: hit ? (hit.className||hit.tagName)+' "'+(hit.textContent||'').slice(0,20)+'"' : 'null',
          menuRect: mr?{x:Math.round(mr.x),y:Math.round(mr.y),w:Math.round(mr.width),h:Math.round(mr.height)}:null,
          wordRect:{x:Math.round(a.x),y:Math.round(a.y)}})})()`),
    );
    console.log('   drag start word:', drag.startWord, '| element at that point:', drag.hitAtStart);
    console.log('   menu rect:', JSON.stringify(drag.menuRect), '| word[0] at:', JSON.stringify(drag.wordRect));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.ax, y: drag.ay, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left', buttons: 1,
        x: drag.ax + ((drag.bx - drag.ax) * i) / 6,
        y: drag.ay + ((drag.by - drag.ay) * i) / 6,
      });
      await sleep(40);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.bx, y: drag.by, button: 'left', buttons: 0 });
    await sleep(700);

    const dragged = await cdp.eval(
      'document.querySelectorAll(\'.subselect-word[data-ss-selected="true"]\').length',
    );
    check('drag selects multiple words', dragged >= 2, `${dragged} words`);

    // The spaces between selected words carry the highlight too, so a phrase reads as one
    // mark rather than one box per word.
    const bridged = await cdp.eval(
      'document.querySelectorAll(\'.subselect-gap[data-ss-selected="true"]\').length',
    );
    check('phrase highlight is continuous', bridged >= dragged - 1, `${bridged} gaps bridged`);
    console.log('   phrase:', await cdp.eval(`[...document.querySelectorAll('[data-ss-selected="true"]')].map(e=>e.textContent).join(' ')`));

    // Every menu action must actually run when clicked.
    for (const [action, label] of [
      ['translate', 'Translate'],
      ['pronounce', 'Pronounce'],
      ['save', 'Save'],
      ['copy', 'Copy'],
    ]) {
      // Drop any previous panel first: it sits above the buttons, so removing it after
      // measuring would move them out from under the click.
      await cdp.eval("document.querySelector('.subselect-menu-result')?.remove(); 1");
      await sleep(120);

      // Matched on the action id: the secondary buttons are icon-only and have no text.
      const spot = JSON.parse(
        await cdp.eval(`(()=>{const b=document.querySelector('[data-ss-action="${action}"]');
          if(!b) return JSON.stringify({found:false});
          const r=b.getBoundingClientRect();
          return JSON.stringify({found:true,x:r.x+r.width/2,y:r.y+r.height/2})})()`),
      );
      if (!spot.found) {
        check(`menu action "${label}" present`, false);
        continue;
      }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type, x: spot.x, y: spot.y, button: 'left', clickCount: 1,
          buttons: type === 'mousePressed' ? 1 : 0,
        });
        await sleep(60);
      }
      // Wait for the panel to settle rather than guessing: a provider chain can take
      // several seconds, and an on-device translator may be loading a language pack.
      let panel = '';
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        panel = await cdp.eval(
          `(()=>{const p=document.querySelector('.subselect-menu-result');
            return p ? (p.dataset.ssState + ': ' + p.textContent.trim().slice(0,70)) : ''})()`,
        );
        if (panel && !panel.startsWith('loading')) break;
      }
      check(`menu action "${label}" responds`, Boolean(panel), panel || 'no result panel');
    }

    /*
     * Rolling captions, driven deterministically.
     *
     * Auto-generated captions (YouTube's especially) grow a word at a time rather than
     * being replaced line by line. Treating each growth as a new caption dropped the
     * selection two or three times a second, which made the feature unusable exactly where
     * a learner most wants it. The page's own timer is too racy to assert against, so the
     * caption is grown by hand here.
     */
    if (mirrored) {
      /*
       * Typography must be copied, never invented: SubSelect is a language tool, not a
       * caption-size tool, so the overlay has to render at exactly the player's own size.
       * Checked with a TWO-LINE caption, because that is the case where the caption
       * container has more than one child and the font is easiest to read off the wrong
       * element.
       */
      await cdp.eval(`(()=>{
        const h = document.querySelector('[data-subselect-hidden="true"]');

        // Reuse the page's own caption element names, so the injected lines carry the same
        // styling the player would give them — otherwise this measures the test's markup
        // rather than the site's.
        const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
        let probe = walker.nextNode();
        while (probe && !probe.nodeValue.trim()) probe = walker.nextNode();
        const inner = probe?.parentElement;
        const innerClass = inner && inner !== h ? inner.className : '';
        const outerClass = inner?.parentElement && inner.parentElement !== h
          ? inner.parentElement.className : '';

        const line = (t) => {
          const s = document.createElement('span');
          s.className = innerClass;
          s.textContent = t;
          if (!outerClass) return s;
          const d = document.createElement('div');
          d.className = outerClass;
          d.appendChild(s);
          return d;
        };
        h.replaceChildren(line('Ich habe gestern'), line('einen interessanten Film gesehen.'));
        return 1})()`);
      await sleep(800);

      const type = JSON.parse(
        await cdp.eval(`(()=>{
          const host = document.querySelector('[data-subselect-hidden="true"]');
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node && !node.nodeValue.trim()) node = walker.nextNode();
          const original = node?.parentElement;
          const ours = document.querySelector('.subselect-word');
          if (!original || !ours) return JSON.stringify({found:false});
          const a = getComputedStyle(original), b = getComputedStyle(ours);
          return JSON.stringify({found:true,
            originalSize: a.fontSize, ourSize: b.fontSize,
            originalFamily: a.fontFamily.split(',')[0], ourFamily: b.fontFamily.split(',')[0],
            originalWeight: a.fontWeight, ourWeight: b.fontWeight})})()`),
      );
      check('overlay matches the caption font size', type.found && type.originalSize === type.ourSize,
        `player ${type.originalSize} vs overlay ${type.ourSize}`);
      check('overlay matches the caption font family and weight',
        type.found && type.originalFamily === type.ourFamily && type.originalWeight === type.ourWeight,
        `${type.originalFamily}/${type.originalWeight} vs ${type.ourFamily}/${type.ourWeight}`);

      await cdp.eval(`(()=>{const h=document.querySelector('[data-subselect-hidden="true"]');
        h.textContent = 'Ich möchte morgen'; return 1})()`);
      await sleep(600);

      const first = JSON.parse(
        await cdp.eval(`(()=>{const w=document.querySelectorAll('.subselect-word');
          if(!w.length) return JSON.stringify({found:false});
          const r=w[0].getBoundingClientRect();
          return JSON.stringify({found:true,x:r.x+r.width/2,y:r.y+r.height/2,text:w[0].textContent})})()`),
      );

      if (first.found) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', {
            type, x: first.x, y: first.y, button: 'left', clickCount: 1,
            buttons: type === 'mousePressed' ? 1 : 0,
          });
          await sleep(60);
        }
        await sleep(400);

        // One more word arrives, exactly as ASR captions do.
        await cdp.eval(`(()=>{const h=document.querySelector('[data-subselect-hidden="true"]');
          h.textContent = 'Ich möchte morgen nach'; return 1})()`);
        await sleep(700);

        const kept = await cdp.eval(
          'document.querySelectorAll(\'.subselect-word[data-ss-selected="true"]\').length',
        );
        const words = await cdp.eval('document.querySelectorAll(".subselect-word").length');
        check('selection survives a caption growing', kept === 1,
          `"${first.text}" kept while the line grew to ${words} words: ${kept} highlighted`);

        // A genuinely different caption must still clear it.
        await cdp.eval(`(()=>{const h=document.querySelector('[data-subselect-hidden="true"]');
          h.textContent = 'Das ist etwas völlig anderes.'; return 1})()`);
        await sleep(700);
        const cleared = await cdp.eval(
          'document.querySelectorAll(\'.subselect-word[data-ss-selected="true"]\').length',
        );
        check('a different caption still clears the selection', cleared === 0, `${cleared} highlighted`);
      }
    }

    // Captured with a result on screen, so the image shows the feature working rather
    // than merely rendering.
    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((s) =>
      writeFileSync(join(ROOT, 'verify.png'), Buffer.from(s.data, 'base64')),
    );

    /*
     * Drive a genuine caption change: the menu must survive it, because captions change
     * every few seconds and a menu that dies with them cannot be read.
     *
     * Mirror mode is rewritten directly. Derived (TextTrack) mode cannot be — its cues are
     * driven by the video clock, which is also why freezing timers does not settle that
     * page — so it waits for the next natural cue instead.
     */
    if (mirrored) {
      await cdp.eval(`(()=>{const h=document.querySelector('[data-subselect-hidden="true"]');
        h.textContent = 'Das ist allerdings schwierig.'; return 'changed'})()`);
      await sleep(900);
    } else {
      // TextTrack cues follow the video clock, and selecting a word has paused it — which
      // is the feature working. Let it run so a cue change can actually happen.
      await cdp.eval('document.querySelector("video").play(); 1');
      await sleep(300);

      await cdp.eval(`(()=>{
        const read = () => document.querySelector('.subselect-layer')?.textContent.trim() ?? '';
        const start = read();
        return new Promise(resolve => {
          let left = 40;
          const timer = setInterval(() => {
            if (read() !== start || --left <= 0) { clearInterval(timer); resolve('changed'); }
          }, 250);
        });
      })()`);
      await sleep(500);
      // Stop the clock so the remaining assertions are not racing the next cue.
      await cdp.eval('document.querySelector("video").pause(); 1');
      await sleep(300);
    }
    const afterCue = JSON.parse(
      await cdp.eval(`(()=>{const m=document.querySelector('.subselect-menu');
        return JSON.stringify({menuOpen: !!m && !m.hasAttribute('hidden'),
          term: m?.querySelector('.subselect-menu-term')?.textContent,
          highlighted: document.querySelectorAll('[data-ss-selected="true"]').length,
          words: document.querySelectorAll('.subselect-word').length})})()`),
    );
    check('menu survives a caption change', afterCue.menuOpen, `term "${afterCue.term}"`);
    check('highlight clears with the old caption', afterCue.highlighted === 0);
    check('new caption is interactive', afterCue.words > 0, `${afterCue.words} words`);

    // Select a word in the NEW caption, so Escape is tested against a live selection.
    const fresh = JSON.parse(
      await cdp.eval(`(()=>{const w=document.querySelectorAll('.subselect-word');
        const r=w[0].getBoundingClientRect();
        return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`),
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: fresh.x, y: fresh.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(80);
    }
    await sleep(600);
    check('word in the new caption is selectable',
      (await cdp.eval('document.querySelectorAll(\'[data-ss-selected="true"]\').length')) === 1);

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
    check('Escape clears the selection', (await cdp.eval('document.querySelectorAll(\'[data-ss-selected="true"]\').length')) === 0);
    check('Escape closes the menu',
      Boolean(await cdp.eval('(()=>{const m=document.querySelector(".subselect-menu");return !m||m.hasAttribute("hidden")})()')));

    /*
     * Recovery, without reloading the page or toggling the extension.
     *
     * Players rebuild their DOM on a seek, an episode change or a re-render, taking our
     * overlay and the nodes we observe with it. Observers on a detached subtree never fire
     * again, so the engine used to sit bound to nothing and the feature looked dead until
     * it was switched off and on. Each case below is one of those, done deliberately.
     */
    const recover = async (label, breakIt) => {
      await breakIt();
      let words = 0;
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        words = await cdp.eval('document.querySelectorAll(".subselect-word").length');
        if (words > 0) break;
      }
      if (words === 0) {
        const state = await cdp.eval(`(()=>JSON.stringify({
          layer: !!document.querySelector('.subselect-layer'),
          hiddenHost: !!document.querySelector('[data-subselect-hidden="true"]'),
          captionText: (document.querySelector('.timedtext, .captions-text, #captions')?.textContent ?? '').trim().slice(0,40),
          videos: document.querySelectorAll('video').length,
          visibility: document.visibilityState,
        }))()`);
        console.log(`      state: ${state}`);
      }
      check(`recovers by itself: ${label}`, words > 0, `${words} clickable words`);
    };

    // 1. The site removes our overlay.
    await recover('overlay removed by the page', () =>
      cdp.eval('document.querySelector(".subselect-layer")?.remove(); 1'),
    );

    // 2. The caption container is replaced by a different element.
    await recover('caption container replaced', () =>
      cdp.eval(`(()=>{
        const host = document.querySelector('[data-subselect-hidden="true"]');
        if (!host) return 0;
        const fresh = host.cloneNode(false);
        fresh.removeAttribute('data-subselect-hidden');
        fresh.textContent = 'Ich muss mich heute entscheiden.';
        host.replaceWith(fresh);
        return 1})()`),
    );

    /*
     * 2b. The user switches to another tab and comes back.
     *
     * A real second tab is opened and brought to the front, so this page's
     * visibilityState genuinely becomes "hidden" — not a faked event. Coming back must
     * leave the feature working; it used to be torn down on hide and never rebuilt, since
     * the detector saw the same video on return and stayed silent.
     */
    if (!process.env.SUBSELECT_HEADFUL) {
      console.log('   (tab-switch check needs a real window: SUBSELECT_HEADFUL=1)');
    } else {
      const before = await cdp.eval('document.querySelectorAll(".subselect-word").length');
      // /json/new must be a PUT in current Chromium; a GET is rejected.
      const other = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (other) {
        await fetch(`http://127.0.0.1:9222/json/activate/${other.id}`);
        await sleep(1200);
        const hidden = await cdp.eval('document.visibilityState');
        await fetch(`http://127.0.0.1:9222/json/activate/${page.id}`);
        await sleep(1200);
        await fetch(`http://127.0.0.1:9222/json/close/${other.id}`).catch(() => {});
        check('page actually went hidden during the tab switch', hidden === 'hidden', hidden);

        // Interaction must work after returning, not merely the overlay be present.
        await sleep(600);
        const back = await cdp.eval('document.querySelectorAll(".subselect-word").length');
        check('still working after switching tabs and back', back > 0 && back === before,
          `${before} words before, ${back} after`);

        const spot = JSON.parse(
          await cdp.eval(`(()=>{const w=document.querySelectorAll('.subselect-word');
            if(!w.length) return JSON.stringify({found:false});
            const r=w[0].getBoundingClientRect();
            return JSON.stringify({found:true,x:r.x+r.width/2,y:r.y+r.height/2})})()`),
        );
        if (spot.found) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await cdp.send('Input.dispatchMouseEvent', {
              type, x: spot.x, y: spot.y, button: 'left', clickCount: 1,
              buttons: type === 'mousePressed' ? 1 : 0,
            });
            await sleep(60);
          }
          await sleep(500);
          const sel = await cdp.eval(
            'document.querySelectorAll(\'.subselect-word[data-ss-selected="true"]\').length',
          );
          check('a word is selectable after returning to the tab', sel === 1, `${sel} highlighted`);
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await sleep(400);
        }
      } else {
        console.log('   (could not open a second tab; tab-switch check skipped)');
      }
    }

    // 3. The whole player subtree is rebuilt, video element included — a Prime Video
    //    transition between titles looks like this from the outside.
    await recover('player rebuilt with a new video element', () =>
      cdp.eval(`(()=>{
        const video = document.querySelector('video');
        const player = video.closest('.player, .html5-video-player') ?? video.parentElement;
        const stream = video.srcObject;
        const clone = player.cloneNode(true);
        player.replaceWith(clone);
        const fresh = clone.querySelector('video');
        fresh.srcObject = stream;
        fresh.play();
        return 1})()`),
    );
  }

  if (cdp.logs.length) console.log('\npage console:\n  ' + cdp.logs.slice(-12).join('\n  '));
} catch (err) {
  console.log('\nDRIVER ERROR:', err.message);
} finally {
  browser.kill();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`);
  process.exit(failed > 0 ? 1 : 0);
}
