// 도트뜨개 자동 점검
// 실행: 저장소 맨 위 폴더에서  npm --prefix tools/check test
// (처음 한 번은 먼저  cd tools/check && npm install)
// 한 항목만 돌리기: CHECK_ONLY=6 (여러 개는 CHECK_ONLY=1,6)
//
// 하는 일: 사이트 파일을 그대로 보여 주는 작은 서버를 띄우고, 컴퓨터에 깔린 Edge(또는 Chrome)를
// 화면 없이 실행해서 사람이 하듯 눌러 보고 결과를 "통과/실패"로 알려 줌. 사이트 파일은 고치지 않음.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch (e) {
  console.log('점검 도구가 아직 설치되지 않았어요. 먼저 tools/check 폴더에서 한 번 설치해 주세요.\n  cd tools/check && npm install');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 작은 서버: 저장소 폴더를 그대로 보여 줌 (없는 주소는 404.html) ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
function startServer() {
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0].split('#')[0]); } catch (e) { res.writeHead(400); return res.end(); }
    let file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    // Cloudflare Pages처럼 .html을 빼고 써도 열림 (예: /404 → 404.html)
    if (!fs.existsSync(file) && !path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': TYPES['.html'] });
        return res.end(fs.readFileSync(path.join(ROOT, '404.html')));
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
// 서버에 직접 물어봐서 파일이 있는지 (주소 끝 / 가 빠진 폴더는 한 번 따라감)
function fetchStatus(base, urlPath, hops = 0) {
  return new Promise(resolve => {
    http.get(base + urlPath, res => {
      res.resume();
      if (res.statusCode === 301 && hops < 2) return resolve(fetchStatus(base, res.headers.location, hops + 1));
      resolve({ status: res.statusCode, type: res.headers['content-type'] || '' });
    }).on('error', () => resolve({ status: 0, type: '' }));
  });
}

/* ---------- 브라우저: 컴퓨터에 깔린 Edge·Chrome을 화면 없이 실행 ---------- */
function findBrowser() {
  const env = process.env.CHECK_BROWSER;
  const list = [
    env,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return list.find(p => fs.existsSync(p));
}
async function startBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error('Edge나 Chrome을 찾지 못했어요. CHECK_BROWSER 환경 변수에 브라우저 실행 파일 위치를 넣어 주세요.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dotteugae-check-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { proc.kill(); throw new Error('브라우저를 띄우지 못했어요.'); }
  await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null });
  const version = await browser.version();
  const stop = async () => {
    try { await browser.disconnect(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  };
  return { browser, version, stop };
}

/* ---------- 도안 파일 풀기 (사이트의 validatePattern과 같은 규칙) ---------- */
function decodePattern(o) {
  const data = [];
  for (const [v, n] of o.cells) for (let q = 0; q < n; q++) data.push(v === 0 ? null : o.colors[v - 1].toUpperCase());
  return { rows: o.rows, cols: o.cols, data, bg: o.bg ? o.bg.toUpperCase() : null };
}
function fromHash(h) { return JSON.parse(Buffer.from(h.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
function diffCells(a, b) { let n = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || null) !== (b[i] || null)) n++; return n; }
const hexToRgb = h => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;

/* ---------- 점검 공통 도구 ---------- */
let BASE, BROWSER;
async function openPage(urlPath, opt = {}) {
  const ctx = await BROWSER.createBrowserContext(); // 새 프로필 = 처음 온 사람
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error') errors.push('콘솔 오류: ' + m.text().split('\n')[0]); });
  const w = opt.width || 1440, h = opt.height || 900;
  await page.setViewport({ width: w, height: h, isMobile: !!opt.mobile, hasTouch: !!opt.mobile, deviceScaleFactor: 1 });
  // 처음 한 번 뜨는 안내 말풍선은 점검에 방해가 되지 않게 '이미 봄'으로 둠
  await page.evaluateOnNewDocument(() => { try { if (localStorage.getItem('crochet-ribbon-hint-shown') === null) localStorage.setItem('crochet-ribbon-hint-shown', '1'); } catch (e) {} });
  const res = await page.goto(BASE + urlPath, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(200);
  return { ctx, page, errors, status: res ? res.status() : 0, close: () => ctx.close() };
}
const grid = page => page.evaluate(() => ({ rows, cols, data: gridData.slice(), bg: bgColor }));
const settle = () => sleep(600); // 자동 저장이 0.25초 뒤에 쓰므로 넉넉히 기다림
async function waitFor(page, fn, ms = 10000, ...args) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await page.evaluate(fn, ...args)) return true; await sleep(150); }
  return false;
}
// i단(위에서부터 0) j코(왼쪽부터 0) 칸의 화면 위치
const cellPoint = (page, i, j) => page.evaluate((i, j) => {
  const r = canvas.getBoundingClientRect();
  const dj = flipped ? (cols - 1 - j) : j;
  return { x: r.left + LABEL_SIZE + (dj + 0.5) * cellW, y: r.top + LABEL_SIZE + (i + 0.5) * cellH };
}, i, j);
// 캔버스에 실제로 그려진 그 칸의 가운데 색
const cellPixel = (page, i, j) => page.evaluate((i, j) => {
  const dpr = canvas.width / canvas.clientWidth;
  const dj = flipped ? (cols - 1 - j) : j;
  const x = Math.round((LABEL_SIZE + (dj + 0.5) * cellW) * dpr), y = Math.round((LABEL_SIZE + (i + 0.5) * cellH) * dpr);
  const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}, i, j);
async function clickCell(page, i, j) { const p = await cellPoint(page, i, j); await page.mouse.click(p.x, p.y); await sleep(150); }
async function pickColor(page, hex) {
  const ok = await page.evaluate(rgb => {
    const sw = [...document.querySelectorAll('#palette .swatch')].find(s => getComputedStyle(s).backgroundColor === rgb);
    if (!sw) return false;
    if (!sw.classList.contains('selected')) sw.click();
    return true;
  }, hexToRgb(hex));
  if (!ok) throw new Error(`팔레트에서 ${hex} 색을 찾지 못했어요`);
  await sleep(100);
}
const clickId = async (page, id) => { await page.click('#' + id); await sleep(200); };

/* ---------- 점검 항목 ---------- */
const RED = '#D32F2F', BLUE = '#1976D2', BLACK = '#222222';
const TESTS = [];
const test = (title, fn) => TESTS.push({ title, fn });

test('칠하기 → 되돌리기 → 다시하기', async (fail) => {
  const t = await openPage('/pattern/');
  try {
    const { page } = t;
    await clickId(page, 'toolPaintBtn');
    await pickColor(page, RED);
    const g0 = await grid(page);
    await clickCell(page, 2, 3);
    let g = await grid(page);
    if (g.data[2 * g.cols + 3] !== RED) fail('칸을 눌렀는데 칠할 색이 들어가지 않았어요');
    else if (await cellPixel(page, 2, 3) !== RED) fail('칸 정보는 바뀌었는데 화면의 칸 색이 바뀌지 않았어요');
    await clickId(page, 'undoBtn');
    g = await grid(page);
    if (g.data[2 * g.cols + 3] !== null || diffCells(g.data, g0.data)) fail('되돌리기를 눌렀는데 칠하기 전으로 돌아오지 않았어요');
    else if (await cellPixel(page, 2, 3) !== g.bg.toUpperCase()) fail('되돌리기 뒤 화면의 칸 색이 배경색으로 돌아오지 않았어요');
    await clickId(page, 'redoBtn');
    g = await grid(page);
    if (g.data[2 * g.cols + 3] !== RED) fail('다시하기를 눌렀는데 다시 칠해지지 않았어요');
    else if (await cellPixel(page, 2, 3) !== RED) fail('다시하기 뒤 화면의 칸 색이 바뀌지 않았어요');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); }
});

test('채우기 도구', async (fail) => {
  const t = await openPage('/pattern/');
  try {
    const { page } = t;
    // 가운데에 세로 벽을 칠하고, 왼쪽을 채우면 왼쪽만 채워져야 함
    await clickId(page, 'toolPaintBtn');
    await pickColor(page, BLACK);
    let g = await grid(page);
    const wall = Math.floor(g.cols / 2);
    for (let i = 0; i < g.rows; i++) await clickCell(page, i, wall);
    await clickId(page, 'toolFillBtn');
    await pickColor(page, BLUE);
    await clickCell(page, 0, 0);
    g = await grid(page);
    let left = 0, right = 0, wallOk = 0;
    for (let i = 0; i < g.rows; i++) for (let j = 0; j < g.cols; j++) {
      const v = g.data[i * g.cols + j];
      if (j < wall && v === BLUE) left++;
      if (j > wall && v === BLUE) right++;
      if (j === wall && v === BLACK) wallOk++;
    }
    if (wallOk !== g.rows) fail(`칠하기로 세로 벽을 만들지 못했어요 (${wallOk}/${g.rows}칸)`);
    if (left !== g.rows * wall) fail(`벽 왼쪽 ${g.rows * wall}칸이 모두 채워져야 하는데 ${left}칸만 채워졌어요`);
    if (right) fail(`벽을 넘어 오른쪽 ${right}칸까지 채워졌어요`);
    if (await cellPixel(page, g.rows - 1, 0) !== BLUE) fail('채운 칸이 화면에 파란색으로 그려지지 않았어요');
    await clickId(page, 'undoBtn');
    g = await grid(page);
    if (g.data.some(v => v === BLUE)) fail('채우기를 되돌렸는데 파란 칸이 남아 있어요');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); }
});

test('새로고침 뒤에도 도안 유지 (자동 저장)', async (fail) => {
  const t = await openPage('/pattern/');
  try {
    const { page } = t;
    await clickId(page, 'toolPaintBtn');
    await pickColor(page, RED);
    for (const [i, j] of [[0, 0], [1, 2], [5, 7], [10, 10]]) await clickCell(page, i, j);
    await pickColor(page, BLUE);
    for (const [i, j] of [[3, 3], [19, 19]]) await clickCell(page, i, j);
    await settle();
    const before = await grid(page);
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
    const after = await grid(page);
    if (after.rows !== before.rows || after.cols !== before.cols) fail(`격자 크기가 바뀌었어요 (${before.cols}×${before.rows} → ${after.cols}×${after.rows})`);
    const d = diffCells(before.data, after.data);
    if (d) fail(`새로고침 뒤 칸 ${d}개가 달라졌어요`);
    if (!after.data.some(Boolean)) fail('새로고침 뒤 칠한 칸이 모두 사라졌어요');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); }
});

test('도안 파일 저장 → 모두 지우기 → 파일 열기, 예시 도안 파일 열기', async (fail) => {
  const t = await openPage('/pattern/');
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'dotteugae-dl-'));
  try {
    const { page, ctx } = t;
    await clickId(page, 'toolPaintBtn');
    await pickColor(page, RED);
    for (const [i, j] of [[0, 0], [2, 5], [7, 7], [8, 7], [9, 7]]) await clickCell(page, i, j);
    await pickColor(page, BLUE);
    for (const [i, j] of [[4, 4], [15, 12]]) await clickCell(page, i, j);
    const before = await grid(page);
    // 내려받기를 임시 폴더로
    const cdp = await page.createCDPSession();
    try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, browserContextId: ctx.id }); }
    catch (e) { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }); }
    await clickId(page, 'saveFileBtn');
    let file = null;
    for (let i = 0; i < 50 && !file; i++) { await sleep(200); file = fs.readdirSync(dl).find(f => f.endsWith('.json')); }
    if (!file) { fail('저장 버튼을 눌렀는데 도안 파일(.json)이 내려받아지지 않았어요'); return; }
    const saved = decodePattern(JSON.parse(fs.readFileSync(path.join(dl, file), 'utf8')));
    if (diffCells(saved.data, before.data) || saved.rows !== before.rows || saved.cols !== before.cols) fail('저장된 파일 내용이 화면의 도안과 달라요');
    await clickId(page, 'clearGridBtn');
    if ((await grid(page)).data.some(Boolean)) fail('모두 지우기를 눌렀는데 칸이 남아 있어요');
    const input = await page.$('#openFileInput');
    await input.uploadFile(path.join(dl, file)); await sleep(500);
    const opened = await grid(page);
    const d = diffCells(opened.data, before.data);
    if (d || opened.rows !== before.rows || opened.cols !== before.cols) fail(`저장한 파일을 다시 열었는데 칸 ${d}개가 달라요`);
    // 예시 도안 파일
    const exFile = path.join(ROOT, 'examples/img/chocolate-box.json');
    const ex = decodePattern(JSON.parse(fs.readFileSync(exFile, 'utf8')));
    await input.uploadFile(exFile); await sleep(500);
    const g = await grid(page);
    if (g.rows !== ex.rows || g.cols !== ex.cols) fail(`예시 도안 파일(chocolate-box.json)을 열었는데 크기가 달라요 (${ex.cols}×${ex.rows} 이어야 하는데 ${g.cols}×${g.rows})`);
    else if (diffCells(g.data, ex.data)) fail(`예시 도안 파일(chocolate-box.json)을 열었는데 칸 ${diffCells(g.data, ex.data)}개가 달라요`);
    if (ex.bg && g.bg.toUpperCase() !== ex.bg) fail('예시 도안 파일의 배경색이 적용되지 않았어요');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); fs.rmSync(dl, { recursive: true, force: true }); }
});

test('예시 페이지·홈의 "이 도안 열어서 고쳐보기" 링크', async (fail, note) => {
  const sources = [['examples/index.html', '/examples/', '예시 페이지'], ['index.html', '/', '홈']];
  let total = 0;
  for (const [file, pagePath, label] of sources) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const links = [...html.matchAll(/href="([^"]*#p=[A-Za-z0-9_-]+)"/g)].map(m => m[1]);
    if (!links.length) fail(`${label}에서 도안 링크를 하나도 찾지 못했어요`);
    const ctx = await BROWSER.createBrowserContext();
    try {
      for (let k = 0; k < links.length; k++) {
        total++;
        const url = new URL(links[k], BASE + pagePath);
        const expect = decodePattern(fromHash(url.hash.slice(3)));
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(url.href, { waitUntil: 'networkidle0' }); await sleep(300);
        const g = await grid(page);
        const name = `${label} ${k + 1}번째 링크`;
        if (g.rows !== expect.rows || g.cols !== expect.cols) fail(`${name}: 크기가 달라요 (${expect.cols}×${expect.rows} 이어야 하는데 ${g.cols}×${g.rows})`);
        else if (diffCells(g.data, expect.data)) fail(`${name}: 칸 ${diffCells(g.data, expect.data)}개가 달라요`);
        else if (expect.bg && g.bg.toUpperCase() !== expect.bg) fail(`${name}: 배경색이 달라요`);
        errors.forEach(e => fail(`${name}: 자바스크립트 오류: ${e}`));
        await page.close();
      }
    } finally { await ctx.close(); }
  }
  note(`링크 ${total}개 확인`);
});

test('글자 넣기, 영어로 바꿨다가 한국어로 돌아오기', async (fail) => {
  const t = await openPage('/pattern/');
  try {
    const { page } = t;
    const insertText = async (text, label) => {
      const before = await grid(page);
      await page.click('.insp-tab[data-pane="text"]'); await sleep(150);
      await page.click('#textInput', { clickCount: 3 });
      await page.evaluate(() => { document.getElementById('textInput').value = ''; });
      await page.type('#textInput', text);
      if (!await waitFor(page, () => !!stamp, 10000)) { fail(`${label}: 문구를 넣었는데 미리보기 글자가 나타나지 않았어요`); return; }
      // 사람이 하듯 글자를 치자마자 버튼을 누름 (글자 칸에서 커서가 빠지는 순간도 실제와 같게)
      await clickId(page, 'convertBtn');
      await sleep(800);
      const after = await grid(page);
      const inserted = after.data.some(Boolean) && !(after.rows === before.rows && after.cols === before.cols && !diffCells(after.data, before.data));
      const floating = await page.evaluate(() => !!(stamp && stamp.isText));
      if (!inserted) fail(`${label}: 도안에 넣기를 눌렀는데 도안에 글자가 들어가지 않았어요`);
      else if (floating) fail(`${label}: 글자는 도안에 들어갔지만, 곧바로 같은 글자가 다시 떠올라 옮기기 상태가 됐어요`);
      if (floating) { await clickId(page, 'stampCancelBtn'); } // 다음 확인을 위해 떠 있는 글자는 치움
    };
    const texts = () => page.evaluate(() => ({
      lang: LANG,
      tabs: [...document.querySelectorAll('.insp-tab')].map(b => b.textContent.trim()),
      caps: [...document.querySelectorAll('.rgroup-cap')].map(b => b.textContent.trim()),
      convert: document.getElementById('convertBtn').textContent.trim(),
    }));
    await insertText('뜨개', '한국어 글자');
    const ko = await texts();
    const g1 = await grid(page);
    await clickId(page, 'langBtn');
    const en = await texts();
    if (en.lang !== 'en' || en.tabs.join() === ko.tabs.join() || !en.tabs.includes('Text')) fail('영어로 바꿨는데 화면 글자가 영어로 바뀌지 않았어요');
    if (diffCells((await grid(page)).data, g1.data)) fail('영어로 바꿨더니 도안이 바뀌었어요');
    await insertText('Hi', '영어 화면에서 글자');
    const g2 = await grid(page);
    await clickId(page, 'langBtn');
    const ko2 = await texts();
    if (ko2.lang !== 'ko') fail('한국어로 다시 바꾸지 못했어요');
    if (ko2.tabs.join() !== ko.tabs.join() || ko2.caps.join() !== ko.caps.join()) fail('한국어로 돌아왔는데 일부 화면 글자가 처음과 달라요');
    if (diffCells((await grid(page)).data, g2.data)) fail('한국어로 바꿨더니 도안이 바뀌었어요');
    await insertText('가', '한국어로 돌아온 뒤 글자');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); }
});

test('작업창 접기·펼치기, 새로고침 뒤 유지', async (fail) => {
  const t = await openPage('/pattern/');
  try {
    const { page } = t;
    const state = () => page.evaluate(() => ({
      folded: document.querySelector('.app').classList.contains('ribbon-folded'),
      ribbonH: document.getElementById('ribbon').offsetHeight,
      handle: [...document.querySelectorAll('.ribbon-handle')].some(b => b.offsetParent !== null),
    }));
    let s = await state();
    if (s.folded || !s.ribbonH) fail('PC 화면 첫 방문인데 작업창이 펼쳐져 있지 않아요');
    await clickId(page, 'ribbonFoldBtn');
    s = await state();
    if (!s.folded || s.ribbonH !== 0) fail('접기 버튼을 눌렀는데 작업창이 접히지 않았어요');
    if (!s.handle) fail('작업창을 접었는데 펼치기 손잡이가 보이지 않아요');
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
    s = await state();
    if (!s.folded) fail('접은 뒤 새로고침했더니 다시 펼쳐졌어요');
    await page.evaluate(() => [...document.querySelectorAll('.ribbon-handle')].find(b => b.offsetParent !== null).click());
    await sleep(300);
    s = await state();
    if (s.folded || !s.ribbonH) fail('손잡이를 눌렀는데 작업창이 펼쳐지지 않았어요');
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
    s = await state();
    if (s.folded) fail('펼친 뒤 새로고침했더니 다시 접혔어요');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); }
});

test('휴대폰(320·360·390)·태블릿(1280)·PC(1440) 화면: 가로 넘침, 잘린 버튼, 오류', async (fail) => {
  const views = [['작은 휴대폰 320px', 320, 640, true], ['휴대폰 360px', 360, 740, true], ['휴대폰 390px', 390, 844, true], ['태블릿 1280px', 1280, 800, true], ['PC 1440px', 1440, 900, false]];
  for (const [label, w, h, mobile] of views) {
    const t = await openPage('/pattern/', { width: w, height: h, mobile });
    try {
      await sleep(500);
      const r = await t.page.evaluate(() => {
        const de = document.documentElement;
        const vw = de.clientWidth;
        // 일부러 옆으로 밀어 보게 만든 곳(가로 스크롤 영역) 안의 버튼은 빼고 셈
        const inScroller = el => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
        const cut = [...document.querySelectorAll('button, a, select, input, summary')]
          .filter(e => e.offsetParent !== null && !inScroller(e))
          .filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > vw + 1 || b.left < -1); })
          .map(e => (e.id || e.getAttribute('aria-label') || e.textContent.trim() || e.tagName).slice(0, 20));
        return { overflow: Math.max(de.scrollWidth, document.body.scrollWidth) - vw, cut };
      });
      if (r.overflow > 1) fail(`${label}: 페이지가 옆으로 ${r.overflow}px 넘쳐서 가로 스크롤이 생겨요`);
      if (r.cut.length) fail(`${label}: 화면 밖으로 잘린 버튼이 있어요 (${r.cut.join(', ')})`);
      t.errors.forEach(e => fail(`${label}: ${e}`));
    } finally { await t.close(); }
  }
});

test('모든 페이지 열림, 깨진 링크·없는 이미지', async (fail, note) => {
  const pages = [
    ['/', '홈'], ['/pattern/', '도안 만들기'], ['/counter/', '코수 세기'], ['/examples/', '예시'],
    ['/guides/', '가이드'], ['/guides/reading-charts/', '가이드: 도안 읽기'], ['/guides/lettering-size/', '가이드: 글자 크기'],
    ['/about/', '소개'], ['/privacy/', '개인정보처리방침'], ['/credits/', '폰트 출처'],
  ];
  const checked = new Map();
  let external = 0, internal = 0;
  const checkUrl = async (raw, where, kind) => {
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(raw)) return;
    let u;
    try { u = new URL(raw, BASE + where); } catch (e) { fail(`${where}: 주소 형식이 이상해요 (${raw})`); return; }
    if (/^(www\.)?crochetalpha\.com$/i.test(u.hostname)) u = new URL(u.pathname + u.search, BASE); // 사이트 주소로 적힌 것은 이 폴더의 파일로 확인
    else if (u.origin !== new URL(BASE).origin) { external++; return; }
    const key = u.pathname;
    internal++;
    if (!checked.has(key)) checked.set(key, await fetchStatus(BASE, key));
    const r = checked.get(key);
    if (r.status !== 200) fail(`${where}: ${kind} "${decodeURIComponent(key)}"이(가) 없어요 (응답 ${r.status})`);
    else if (kind === '이미지' && !/^image\//.test(r.type)) fail(`${where}: 이미지 "${key}"가 그림 파일이 아니에요`);
  };
  for (const [p, label] of pages) {
    const t = await openPage(p);
    try {
      if (t.status !== 200) { fail(`${label}(${p}) 페이지가 열리지 않아요 (응답 ${t.status})`); continue; }
      const refs = await t.page.evaluate(() => {
        const out = [];
        document.querySelectorAll('a[href]').forEach(a => out.push(['링크', a.getAttribute('href')]));
        document.querySelectorAll('img[src]').forEach(i => out.push(['이미지', i.getAttribute('src')]));
        document.querySelectorAll('img[srcset], source[srcset]').forEach(i => i.getAttribute('srcset').split(',').forEach(s => out.push(['이미지', s.trim().split(/\s+/)[0]])));
        document.querySelectorAll('link[href]').forEach(l => out.push([/icon/.test(l.rel) ? '이미지' : '파일', l.getAttribute('href')]));
        document.querySelectorAll('script[src]').forEach(s => out.push(['파일', s.getAttribute('src')]));
        document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(m => out.push(['이미지', m.getAttribute('content')]));
        return out;
      });
      for (const [kind, raw] of refs) await checkUrl(raw, p, kind);
      t.errors.forEach(e => fail(`${label}: ${e}`));
    } finally { await t.close(); }
  }
  // 없는 주소 → 404 페이지
  const t = await openPage('/no-such-page-for-check/');
  try {
    if (t.status !== 404) fail(`없는 주소인데 응답이 404가 아니에요 (${t.status})`);
    const ok = await t.page.evaluate(() => /404|찾을 수 없/.test(document.body.innerText));
    if (!ok) fail('없는 주소에서 404 안내 페이지가 보이지 않아요');
    const refs = await t.page.evaluate(() => [...document.querySelectorAll('a[href], img[src], link[href]')].map(e => [e.tagName === 'IMG' ? '이미지' : '링크', e.getAttribute('href') || e.getAttribute('src')]));
    for (const [kind, raw] of refs) await checkUrl(raw, '/no-such-page-for-check/', kind);
    t.errors.filter(e => !/404/.test(e)).forEach(e => fail(`404 페이지: ${e}`));
  } finally { await t.close(); }
  // sitemap.xml에 적힌 주소
  const sm = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  for (const m of sm.matchAll(/<loc>([^<]+)<\/loc>/g)) await checkUrl(m[1].trim(), '/sitemap.xml', '주소');
  note(`사이트 안 주소 ${checked.size}곳 확인, 바깥 사이트 링크 ${external}개는 확인하지 않음`);
});

/* ---------- 실행 ---------- */
(async () => {
  const started = Date.now();
  const server = await startServer();
  BASE = 'http://127.0.0.1:' + server.address().port;
  let br;
  try { br = await startBrowser(); }
  catch (e) { console.log('점검을 시작하지 못했어요: ' + e.message); server.close(); process.exit(2); }
  BROWSER = br.browser;
  console.log(`도트뜨개 자동 점검 (브라우저: ${br.version})\n`);
  let failed = 0;
  // CHECK_ONLY=6 처럼 번호를 주면 그 항목만 (쉼표로 여러 개)
  const only = (process.env.CHECK_ONLY || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);
  for (let k = 0; k < TESTS.length; k++) {
    if (only.length && !only.includes(k + 1)) continue;
    const { title, fn } = TESTS[k];
    const reasons = [], notes = [];
    try {
      await Promise.race([
        fn(r => reasons.push(r), n => notes.push(n)),
        sleep(120000).then(() => { throw new Error('2분 안에 끝나지 않았어요'); }),
      ]);
    } catch (e) {
      reasons.push('점검 도중 멈췄어요: ' + String(e.message || e).split('\n')[0]);
    }
    const uniq = [...new Set(reasons)];
    if (uniq.length) failed++;
    console.log(`${uniq.length ? '[실패]' : '[통과]'} ${k + 1}. ${title}${notes.length ? '  (' + notes.join(', ') + ')' : ''}`);
    uniq.slice(0, 12).forEach(r => console.log('        - ' + r));
    if (uniq.length > 12) console.log(`        - …그 밖에 ${uniq.length - 12}개`);
  }
  await br.stop();
  server.close();
  const secs = Math.round((Date.now() - started) / 1000);
  const ran = only.length ? TESTS.filter((x, k) => only.includes(k + 1)).length : TESTS.length;
  console.log(`\n${ran}개 중 ${ran - failed}개 통과${failed ? `, ${failed}개 실패` : ''} (${secs}초)`);
  process.exit(failed ? 1 : 0);
})();
