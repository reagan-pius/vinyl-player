#!/usr/bin/env node
/**
 * Browser smoke test — drives the real app in headless Chrome.
 *
 * The DSP harness proves the processor; this proves the wiring around it:
 * import → tag/duration metadata → decode → worklet → gain → position
 * reporter, plus the behaviours that are easy to break silently:
 *
 *   1. the app mounts and exposes the file picker
 *   2. dropping two files yields two queue rows with parsed metadata
 *   3. play advances the clock and the deck reports "playing"
 *   4. the track end auto-advances to track 2 *without stopping*
 *   5. pause freezes the clock
 *   6. remove / eject mutate the crate and restore the empty state
 *   7. the page threw no exceptions along the way
 *
 * Self-contained: picks free ports, starts `vite preview` against `dist/`,
 * launches Chrome with a throwaway profile, and kills both afterwards.
 *
 *   npm run test:smoke
 *
 * Requires a production build (`npm run test:smoke` runs one first) and a
 * Chrome/Chromium binary. Set CHROME_PATH to override detection.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

// --------------------------------------------------------------- environment

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      path.join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    ],
  }[process.platform] ?? [];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf8',
      }).trim().split('\n')[0];
      if (found && fs.existsSync(found)) return found;
    } catch {
      // not on PATH
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  return false;
}

function writeWav(file, seconds) {
  const sampleRate = 44100;
  const frames = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buffer);
}

// ------------------------------------------------------------------ CDP client

async function openPage(debugPort) {
  const base = `http://127.0.0.1:${debugPort}`;
  let socketUrl = null;
  for (let i = 0; i < 120 && !socketUrl; i++) {
    try {
      const targets = await (await fetch(`${base}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) socketUrl = page.webSocketDebuggerUrl;
    } catch {
      // browser still starting
    }
    if (!socketUrl) await sleep(150);
  }
  if (!socketUrl) throw new Error('Chrome never exposed a debuggable page');

  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  const errors = [];
  let seq = 0;
  let method = '';

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not attach to Chrome')), { once: true });
  });

  const send = (name, params = {}) => {
    method = name;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method: name, params }));
    });
  };

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  return { send, evaluate, errors, close: () => socket.close() };
}

/** Poll an expression until it satisfies `predicate`, so slow CI doesn't flake. */
async function waitFor(evaluate, expression, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------------ run

const chromePath = findChrome();
if (!chromePath) {
  console.log('--- browser smoke ---');
  console.log('  SKIPPED  no Chrome/Chromium found — set CHROME_PATH to run this test');
  process.exit(0);
}
if (typeof WebSocket === 'undefined') {
  console.error('FAIL: this test needs the global WebSocket from Node 22+');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('FAIL: dist/ is missing — run `npm run build` first (npm run test:smoke does this)');
  process.exit(1);
}

const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  console.error('FAIL: vite is not installed — run `npm install` first');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-smoke-'));
const profileDir = path.join(tmpDir, 'chrome-profile');
const firstTrack = path.join(tmpDir, 'Test Artist - First Song.wav');
const secondTrack = path.join(tmpDir, 'Test Artist - Second Song.wav');
writeWav(firstTrack, 4);
writeWav(secondTrack, 4);

const children = [];
const stopAll = () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
};
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

let preview = null;
let chrome = null;
let page = null;

try {
  console.log('--- browser smoke (headless Chrome) ---');

  const appPort = await freePort();
  const debugPort = await freePort();
  const appUrl = `http://127.0.0.1:${appPort}/`;

  preview = spawn(
    process.execPath,
    [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(preview);
  let previewLog = '';
  preview.stdout.on('data', (chunk) => { previewLog += chunk; });
  preview.stderr.on('data', (chunk) => { previewLog += chunk; });

  if (!(await waitForHttp(appUrl, 20000))) {
    throw new Error(`preview server never came up:\n${previewLog}`);
  }

  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      // The deck only makes sound after a real click; this lets the clock run
      // in headless without a gesture.
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  children.push(chrome);

  page = await openPage(debugPort);
  await page.send('Page.enable');
  await page.send('DOM.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: appUrl });

  await waitFor(page.evaluate, `!!document.querySelector('input[type=file]')`, Boolean, 20000, 'the app to mount');
  check('app mounts', true);

  const document = await page.send('DOM.getDocument', { depth: -1 });
  const picker = await page.send('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type=file]',
  });
  if (!picker.nodeId) throw new Error('file input disappeared after mount');
  await page.send('DOM.setFileInputFiles', { nodeId: picker.nodeId, files: [firstTrack, secondTrack] });

  const rows = await waitFor(page.evaluate, `document.querySelectorAll('.queue-row').length`, (n) => n === 2, 20000, 'two imported rows');
  check('imports two files', rows === 2, `${rows} rows`);

  const title = await page.evaluate(`document.querySelector('.q-name')?.textContent`);
  const artist = await page.evaluate(`document.querySelector('.q-artist')?.textContent`);
  const duration = await page.evaluate(`document.querySelector('.time-row span:last-child')?.textContent`);
  check('parses filename metadata', title === 'First Song' && artist === 'Test Artist', `${title} / ${artist}`);
  check('reads duration from the container', duration === '0:04', duration);
  check('seek becomes available', await page.evaluate(`!document.querySelector('.seek')?.disabled`));

  await page.evaluate(`document.querySelector('.t-play').click()`);
  const stateWhilePlaying = await waitFor(
    page.evaluate,
    `document.querySelector('.platter-rpm i')?.textContent ?? ''`,
    (value) => String(value).includes('playing'),
    10000,
    'the deck to report playing',
  );
  check('deck reports playing', String(stateWhilePlaying).includes('playing'), String(stateWhilePlaying).trim());

  const position = await waitFor(
    page.evaluate,
    `document.querySelector('.time-row span')?.textContent ?? ''`,
    (value) => value !== '0:00',
    10000,
    'the playback clock to advance',
  );
  check('playback clock advances', position !== '0:00', position);

  // 4 s track + 0.7 s cue lead-in: the deck must roll into track 2 by itself.
  const advancedTo = await waitFor(
    page.evaluate,
    `document.querySelector('.track-title')?.textContent ?? ''`,
    (value) => value === 'Second Song',
    15000,
    'auto-advance to the second track',
  );
  check('auto-advances to track 2', advancedTo === 'Second Song', advancedTo);

  const stateAfterHandoff = String(
    await waitFor(
      page.evaluate,
      `document.querySelector('.platter-rpm i')?.textContent ?? ''`,
      (value) => String(value).includes('playing'),
      3000,
      'the deck to stay playing across the handoff',
    ),
  );
  check('keeps playing across the handoff', stateAfterHandoff.includes('playing'), stateAfterHandoff.trim());

  // Regression: a stale reporter write made track 2 start at ~its own end.
  const handoffPosition = await page.evaluate(`document.querySelector('.time-row span')?.textContent ?? ''`);
  check('next track starts at its beginning', /^0:0[0-2]$/.test(String(handoffPosition)), String(handoffPosition));

  await page.evaluate(`document.querySelector('.t-play').click()`);
  await sleep(500);
  const pausedAt = await page.evaluate(`document.querySelector('.time-row span')?.textContent`);
  await sleep(900);
  const pausedStill = await page.evaluate(`document.querySelector('.time-row span')?.textContent`);
  check('pause freezes the clock', pausedAt === pausedStill, String(pausedAt));

  await page.evaluate(`document.querySelector('.q-remove').click()`);
  await waitFor(page.evaluate, `document.querySelectorAll('.queue-row').length`, (n) => n === 1, 5000, 'the removed row to disappear');
  check('remove drops a row', true, '2 -> 1');

  await page.evaluate(`document.querySelector('.link-btn').click()`);
  await waitFor(page.evaluate, `document.querySelectorAll('.queue-row').length`, (n) => n === 0, 5000, 'the crate to empty');
  const emptyTitle = await page.evaluate(`document.querySelector('.track-title')?.textContent`);
  check('eject empties the crate', emptyTitle === 'No record loaded', emptyTitle);

  check('no page exceptions', page.errors.length === 0, page.errors.join(' | '));
} catch (error) {
  failures++;
  console.log(`  FAIL  ${error.message}`);
} finally {
  try { page?.close(); } catch { /* socket already closed */ }
  stopAll();
  await sleep(200);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log();
if (failures) {
  console.log(`=== ${failures} CHECK(S) FAILED ===`);
  process.exit(1);
}
console.log('=== ALL BROWSER CHECKS PASS ===');
