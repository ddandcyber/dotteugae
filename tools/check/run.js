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
const AD_HOST = 'pagead2.googlesyndication.com';
const isAdScript = u => { try { return new URL(u).hostname === AD_HOST; } catch (e) { return false; } };
async function stubAdScript(page) {
  const cdp = await page.createCDPSession();
  cdp.on('Fetch.requestPaused', e => cdp.send('Fetch.fulfillRequest', {
    requestId: e.requestId, responseCode: 200, body: '',
    responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
  }).catch(() => {}));
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*://' + AD_HOST + '/*' }] });
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
  // 애드센스 광고 코드(pagead2.googlesyndication.com)만 예외: 점검 중에는 실제로 받지 않고 빈 스크립트로 대신 줌.
  // 이 주소만 가로채므로(Fetch 패턴) 다른 요청은 그대로이고, 다른 바깥 요청은 23번 등에서 계속 실패로 잡힘.
  const newContext = browser.createBrowserContext.bind(browser);
  browser.createBrowserContext = async (...a) => {
    const ctx = await newContext(...a);
    const newPage = ctx.newPage.bind(ctx);
    ctx.newPage = async (...b) => { const page = await newPage(...b); await stubAdScript(page); return page; };
    return ctx;
  };
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
// 빈 도안으로 열면 시작 화면이 뜨므로, 다른 기능을 보는 점검은 사람처럼 "빈 격자로 시작"을 눌러 넘김 (시작 화면 자체는 13번에서 확인)
const SKIP_START = () => { document.addEventListener('DOMContentLoaded', () => { const b = document.getElementById('startBlank'); if (b && document.querySelector('.app.start-mode')) b.click(); }); };
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
  if (!opt.keepStart) await page.evaluateOnNewDocument(SKIP_START);
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
    const sw = [...document.querySelectorAll('#qbPalette .swatch')].find(s => getComputedStyle(s).backgroundColor === rgb); // 새 도구 막대의 칠할 색 (4단계부터 화면에 보이는 곳)
    if (!sw) return false;
    if (!sw.classList.contains('selected')) sw.click();
    return true;
  }, hexToRgb(hex));
  if (!ok) throw new Error(`팔레트에서 ${hex} 색을 찾지 못했어요`);
  await sleep(100);
}
// 4단계부터 옛 작업창·맨 위 막대의 버튼은 화면에서 숨겨져 있음(id·기능은 그대로). 숨은 버튼을 누르라고 하면
// 사람처럼 새 도구 막대의 같은 버튼을 누르거나, 저장·더보기 메뉴를 열고 그 항목(data-click = 옛 id)을 누름
const NEW_PLACE = { toolPaintBtn: 'qbPaint', toolFillBtn: 'qbFill', undoBtn: 'qbUndo', redoBtn: 'qbRedo', openFileBtn: 'qbOpen', knitStartBtn: 'qbKnit' };
const clickId = async (page, id) => {
  const shown = await page.evaluate(i => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }, id);
  if (shown || !await page.evaluate(i => !!document.getElementById(i), id)) { await page.click('#' + id); await sleep(200); return; }
  if (NEW_PLACE[id]) { await page.click('#' + NEW_PLACE[id]); await sleep(200); return; }
  const menu = await page.evaluate(i => { const it = document.querySelector('.qb-menu .qb-mi[data-click="' + i + '"]'); return it ? it.closest('.qb-menu').id : null; }, id);
  if (!menu) { await page.click('#' + id); await sleep(200); return; } // 새 자리가 없으면 그대로 (점검이 실패로 알려 줌)
  const btn = menu === 'qbSaveMenu' ? 'qbSave' : 'qbMore';
  if (await page.evaluate(m => document.getElementById(m).hidden, menu)) { await page.click('#' + btn); await sleep(150); }
  await page.click('#' + menu + ' .qb-mi[data-click="' + id + '"]'); await sleep(200);
};

/* ---------- 점검 항목 ---------- */
const RED = '#D32F2F', BLUE = '#1976D2', BLACK = '#222222';
const TESTS = [];
// 제한 시간은 보통 2분. 오래 걸리는 항목만 test(이름, 함수, { limitMin: 4 })처럼 따로 정함
const test = (title, fn, opt = {}) => TESTS.push({ title, fn, limitMin: opt.limitMin || 2 });

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

test('도안 파일 저장 → 모두 지우기 → 파일 열기, 예시 도안 파일 열기, 캔버스에 끌어다 놓기, 패널의 도안 파일 묶음은 숨김(버튼 id는 남음)', async (fail) => {
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
    // 5a: 오른쪽 패널의 "도안 파일" 묶음은 화면에 없어도, 캔버스에 파일을 끌어다 놓으면 열림 (처음에 저장한 파일)
    const txt = fs.readFileSync(path.join(dl, file), 'utf8');
    await page.evaluate((txt, name) => {
      const dt = new DataTransfer(); dt.items.add(new File([txt], name, { type: 'application/json' }));
      const st = document.querySelector('.stage');
      st.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      st.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, txt, file);
    await sleep(500);
    const dropped = await grid(page);
    if (diffCells(dropped.data, before.data) || dropped.rows !== before.rows || dropped.cols !== before.cols) fail('도안 파일을 캔버스에 끌어다 놓았는데 그 도안이 열리지 않았어요');
    const fs5 = await page.evaluate(() => ({ shown: [...document.querySelectorAll('.file-sec')].some(e => e.getClientRects().length > 0), ids: ['saveFileBtn2', 'openFileBtn2', 'copyLinkBtn'].every(i => !!document.getElementById(i)) }));
    if (fs5.shown) fail('오른쪽 패널의 "도안 파일" 묶음(저장·열기·링크 복사)이 아직 화면에 보여요 (5a에서 새 도구 막대·더보기로 옮김)');
    if (!fs5.ids) fail('숨긴 "도안 파일" 묶음의 버튼(saveFileBtn2·openFileBtn2·copyLinkBtn)이 페이지에서 사라졌어요');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); fs.rmSync(dl, { recursive: true, force: true }); }
});

test('예시 페이지·홈의 "이 도안 열어서 고쳐보기" 링크', async (fail, note) => {
  const sources = [['examples/index.html', '/examples/', '예시 페이지'], ['index.html', '/', '홈'], ['en/index.html', '/en/', '영어 홈']];
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
    // 언어 버튼은 반대편 주소(/pattern/ ↔ /en/pattern/)로 가는 링크. 누르면 페이지가 바뀜
    const switchLang = async () => {
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), page.click('#langBtn')]);
      await sleep(300);
      return new URL(page.url()).pathname;
    };
    await insertText('뜨개', '한국어 글자');
    const ko = await texts();
    const g1 = await grid(page);
    if (ko.lang !== 'ko') fail('한국어 /pattern/이 한국어로 열리지 않았어요');
    let p = await switchLang();
    if (p !== '/en/pattern/') fail(`EN을 눌렀는데 /en/pattern/이 아니라 ${p}로 갔어요`);
    const en = await texts();
    if (en.lang !== 'en' || en.tabs.join() === ko.tabs.join() || !en.tabs.includes('Text')) fail('영어 페이지인데 화면 글자가 영어가 아니에요');
    if (diffCells((await grid(page)).data, g1.data)) fail('영어 페이지로 갔더니 도안이 바뀌었어요 (자동 저장이 이어지지 않음)');
    await insertText('Hi', '영어 화면에서 글자');
    const g2 = await grid(page);
    p = await switchLang();
    if (p !== '/pattern/') fail(`한국어를 눌렀는데 /pattern/이 아니라 ${p}로 갔어요`);
    const ko2 = await texts();
    if (ko2.lang !== 'ko') fail('한국어로 다시 바꾸지 못했어요');
    if (ko2.tabs.join() !== ko.tabs.join() || ko2.caps.join() !== ko.caps.join()) fail('한국어로 돌아왔는데 일부 화면 글자가 처음과 달라요');
    if (diffCells((await grid(page)).data, g2.data)) fail('한국어로 바꿨더니 도안이 바뀌었어요');
    await insertText('가', '한국어로 돌아온 뒤 글자');
    // 주소에 도안(#p=…)이 남아 있으면 언어를 바꿔도 같은 도안이 열려야 함
    const exHash = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/#p=([A-Za-z0-9_-]+)/) || [])[1];
    if (!exHash) fail('홈에서 도안 링크를 찾지 못했어요');
    else {
      const expect = decodePattern(fromHash(exHash));
      await page.evaluate(h => history.replaceState(null, '', location.pathname + '#p=' + h), exHash);
      p = await switchLang();
      const g3 = await grid(page);
      if (p !== '/en/pattern/') fail('도안 링크가 있을 때 EN을 눌렀는데 영어 페이지로 가지 않았어요');
      else if (g3.rows !== expect.rows || g3.cols !== expect.cols || diffCells(g3.data, expect.data)) fail('도안 링크(#p=)를 이어 붙여 영어 페이지로 갔는데 같은 도안이 열리지 않았어요');
    }
    // 예전 설정(crochet-ui-lang = en)이 남아 있어도 한국어 페이지는 한국어로
    await page.evaluate(() => localStorage.setItem('crochet-ui-lang', 'en'));
    await page.goto(BASE + '/pattern/', { waitUntil: 'networkidle0' }); await sleep(300);
    if ((await texts()).lang !== 'ko') fail('예전 언어 설정이 en이면 한국어 /pattern/이 영어로 열려요');
    if (await page.evaluate(() => localStorage.getItem('crochet-ui-lang')) !== 'en') fail('예전 언어 설정(crochet-ui-lang)을 건드렸어요');
    t.errors.forEach(e => fail(e));
  } finally { await t.close(); }
});

// (4단계에서 다시 씀) 예전: 작업창 접기·펼치기와 새로고침 뒤 유지. 지금은 옛 작업창·접기 버튼·손잡이가 화면에 없으므로
// 그것들이 안 보이는지, 칠할 색이 막대에 항상 있는지, 예전에 저장된 접기 값(접힘·펼침)과 Ctrl+\가 있어도 화면이 같고 저장 이름이 그대로인지 확인
test('옛 작업창 정리: 작업창·접기 버튼·손잡이·말풍선이 화면에 없음, 칠할 색은 막대에 항상, 예전 접기 저장값(접힘·펼침)·새로고침 뒤에도 같은 화면, 없앤 단축키 Ctrl+\\는 아무 동작 없음 (PC·휴대폰)', async (fail) => {
  const state = page => page.evaluate(() => {
    const shown = s => [...document.querySelectorAll(s)].some(e => e.getClientRects().length > 0);
    const r = document.querySelector('.workspace').getBoundingClientRect();
    return { ribbon: shown('#ribbon'), fold: shown('#ribbonFoldBtn'), handle: shown('.ribbon-handle'), hint: shown('#ribbonHint.show'),
      colors: shown('#qbColors') && shown('#qbPalette .swatch'), top: Math.round(r.top), pad: getComputedStyle(document.querySelector('.stage .canvas-wrap')).paddingTop,
      tabsPad: getComputedStyle(document.querySelector('.insp-tabs')).paddingRight };
  });
  for (const [label, w, h, mobile] of [['PC', 1440, 900, false], ['휴대폰 360px', 360, 740, true]]) {
    let base = null;
    for (const saved of [null, '1', '0']) {
      const ctx = await BROWSER.createBrowserContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
      const L = label + (saved === null ? ' 처음 방문' : saved === '1' ? ' 예전 "접힘" 저장값' : ' 예전 "펼침" 저장값');
      try {
        await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
        await page.evaluateOnNewDocument(v => { try { if (v !== null) localStorage.setItem('crochet-ribbon-folded', v); } catch (e) {} }, saved);
        await page.evaluateOnNewDocument(SKIP_START);
        await page.goto(BASE + '/pattern/', { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(900);
        let s = await state(page);
        if (s.ribbon || s.fold || s.handle) fail(L + ': 옛 작업창이나 접기 버튼·손잡이가 화면에 보여요 (' + JSON.stringify(s) + ')');
        if (s.hint) fail(L + ': "여기를 누르면 도구가 펼쳐져요" 말풍선이 떠요');
        if (!s.colors) fail(L + ': 새 도구 막대에 칠할 색이 보이지 않아요');
        if (base && (s.top !== base.top || s.pad !== base.pad || s.tabsPad !== base.tabsPad)) fail(L + ': 처음 방문과 화면 배치가 달라요 (' + JSON.stringify([base, s]) + ')');
        if (!base) base = s;
        // Ctrl+\ (예전 접기 단축키, 5a에서 없앰)를 눌러도 아무 일 없음: 화면·접기 상태·저장값이 그대로이고 오류가 없음
        const kb0 = await page.evaluate(() => ({ v: localStorage.getItem('crochet-ribbon-folded'), f: document.querySelector('.app').classList.contains('ribbon-folded') }));
        await page.keyboard.down('Control'); await page.keyboard.press('Backslash'); await page.keyboard.up('Control'); await sleep(300);
        s = await state(page);
        if (s.ribbon || s.handle || !s.colors || s.top !== base.top) fail(L + ': Ctrl+\\를 누른 뒤 화면이 바뀌었어요 (' + JSON.stringify(s) + ')');
        const kb1 = await page.evaluate(() => ({ v: localStorage.getItem('crochet-ribbon-folded'), f: document.querySelector('.app').classList.contains('ribbon-folded') }));
        if (kb1.v !== kb0.v || kb1.f !== kb0.f) fail(L + ': 없앤 단축키 Ctrl+\\가 아직 접기 상태나 저장값을 바꿔요 (' + JSON.stringify([kb0, kb1]) + ')');
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        s = await state(page);
        if (s.ribbon || s.handle || !s.colors || s.top !== base.top) fail(L + ': 새로고침 뒤 화면이 바뀌었어요 (' + JSON.stringify(s) + ')');
        // 저장 이름은 그대로 (지우거나 다른 값으로 바꾸지 않음)
        const v = await page.evaluate(() => localStorage.getItem('crochet-ribbon-folded'));
        if (saved !== null && v === null) fail(L + ': 예전 저장값 crochet-ribbon-folded가 지워졌어요');
        errors.forEach(e => fail(L + ': ' + e));
      } finally { await ctx.close(); }
    }
  }
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
    ['/guides/', '가이드'], ['/guides/reading-charts/', '가이드: 도안 읽기'], ['/guides/lettering-size/', '가이드: 글자 크기'], ['/guides/knitting-direction/', '가이드: 뜨는 방향'], ['/guides/patchwork-practice/', '가이드: 편물 이어붙이기'],
    ['/about/', '소개'], ['/privacy/', '개인정보처리방침'], ['/credits/', '폰트 출처'],
    ['/en/', '영어 홈'], ['/en/pattern/', '영어 도안 만들기'],
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

test('한국어·영어 페이지 짝: hreflang, canonical, html lang', async (fail, note) => {
  // [한국어 파일, 한국어 주소, 영어 파일, 영어 주소]
  const SITE = 'https://crochetalpha.com';
  const pairs = [['index.html', '/', 'en/index.html', '/en/'], ['pattern/index.html', '/pattern/', 'en/pattern/index.html', '/en/pattern/']];
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  const read = file => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const head = (html.match(/<head>[\s\S]*?<\/head>/) || [''])[0];
    const canon = [...head.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map(m => m[1]);
    const alt = {};
    for (const m of head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)) {
      if (alt[m[1]]) fail(`${file}: hreflang="${m[1]}"이 두 번 있어요`);
      alt[m[1]] = m[2];
    }
    return { lang: (html.match(/<html lang="([^"]+)"/) || [])[1], canon, alt };
  };
  for (const [koFile, koPath, enFile, enPath] of pairs) {
    const koUrl = SITE + koPath, enUrl = SITE + enPath;
    const ko = read(koFile), en = read(enFile);
    for (const [file, pg, lang, url] of [[koFile, ko, 'ko', koUrl], [enFile, en, 'en', enUrl]]) {
      if (pg.lang !== lang) fail(`${file}: <html lang>이 "${lang}"이어야 하는데 "${pg.lang}"이에요`);
      if (pg.canon.length !== 1 || pg.canon[0] !== url) fail(`${file}: canonical이 자기 주소(${url})가 아니에요 (${pg.canon.join(', ') || '없음'})`);
      if (pg.alt.ko !== koUrl) fail(`${file}: hreflang="ko"가 ${koUrl}을 가리켜야 해요 (${pg.alt.ko || '없음'})`);
      if (pg.alt.en !== enUrl) fail(`${file}: hreflang="en"이 ${enUrl}을 가리켜야 해요 (${pg.alt.en || '없음'})`);
      if (pg.alt['x-default'] !== koUrl) fail(`${file}: hreflang="x-default"가 한국어 주소 ${koUrl}을 가리켜야 해요 (${pg.alt['x-default'] || '없음'})`);
      if (Object.keys(pg.alt).length !== 3) fail(`${file}: hreflang은 ko, en, x-default 세 개만 있어야 해요 (${Object.keys(pg.alt).join(', ')})`);
      if (!sitemap.includes(`<loc>${url}</loc>`)) fail(`sitemap.xml에 ${url}이 없어요`);
    }
  }
  // 브라우저에서도: 각 페이지가 열린 뒤의 html lang (스크립트가 바꾸는 경우까지)
  for (const [p, lang] of [['/', 'ko'], ['/en/', 'en'], ['/pattern/', 'ko'], ['/en/pattern/', 'en']]) {
    const t = await openPage(p);
    try {
      const got = await t.page.evaluate(() => document.documentElement.lang);
      if (got !== lang) fail(`${p}: 페이지가 열린 뒤 html lang이 "${lang}"이 아니라 "${got}"이에요`);
      t.errors.forEach(e => fail(`${p}: ${e}`));
    } finally { await t.close(); }
  }
  note(`짝 ${pairs.length}개, 페이지 ${pairs.length * 2}개 확인`);
});

test('이미지 저장은 PNG 내려받기, 공유 버튼은 터치 기기에서만', async (fail, note) => {
  // 1) PC(마우스): '이미지로 저장'을 누르면 공유 창 없이 PNG가 내려받아지고, 공유 버튼은 숨어 있어야 함
  for (const p of ['/pattern/', '/en/pattern/']) {
    const t = await openPage(p);
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'dotteugae-img-'));
    try {
      const { page, ctx } = t;
      // 브라우저가 파일 공유를 지원하는 것처럼 꾸며도(Windows PC 상황) 공유 창을 열면 안 됨
      await page.evaluate(() => {
        window.__shareCalls = 0;
        navigator.canShare = () => true;
        navigator.share = async () => { window.__shareCalls++; };
      });
      const cdp = await page.createCDPSession();
      try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, browserContextId: ctx.id }); }
      catch (e) { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }); }
      const shareShown = await page.evaluate(() => !document.getElementById('shareImgBtn').hidden || !document.getElementById('qbShareItem').hidden); // 4단계: 공유는 저장 메뉴 안
      if (shareShown) fail(`${p}: 마우스를 쓰는 PC인데 공유 버튼이 보여요`);
      await clickId(page, 'saveImgBtn');
      let file = null;
      for (let i = 0; i < 50 && !file; i++) { await sleep(200); file = fs.readdirSync(dl).find(f => f.endsWith('.png')); }
      if (!file) fail(`${p}: '이미지로 저장'을 눌렀는데 PNG 파일이 내려받아지지 않았어요`);
      else {
        await sleep(300);
        const buf = fs.readFileSync(path.join(dl, file));
        if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504E47) fail(`${p}: 내려받은 파일이 PNG가 아니에요 (${file})`);
        if (!/_\d+x\d+_\d{8}\.png$/.test(file)) fail(`${p}: 파일 이름 형식이 달라요 (${file})`);
      }
      if (await page.evaluate(() => window.__shareCalls)) fail(`${p}: '이미지로 저장'을 눌렀는데 공유 창을 열었어요`);
      t.errors.forEach(e => fail(`${p}: ${e}`));
    } finally { await t.close(); fs.rmSync(dl, { recursive: true, force: true }); }
  }
  // 2) 휴대폰(터치, 파일 공유 가능): 공유 버튼이 보이고, 누르면 같은 PNG를 공유 시트로 넘김. 360px에서도 맨 위 막대가 넘치지 않아야 함
  let coarseSeen = false;
  for (const [p, w] of [['/pattern/', 360], ['/en/pattern/', 390]]) {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    try {
      await page.setViewport({ width: w, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => {
        try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); } catch (e) {}
        window.__shared = null;
        navigator.canShare = d => !!(d && d.files && d.files.length);
        navigator.share = async d => { const f = d.files[0]; window.__shared = { n: d.files.length, type: f.type, name: f.name, size: f.size }; };
      });
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
      const st = await page.evaluate(() => {
        document.getElementById('qbSave').click(); // 4단계: 공유는 저장 메뉴 안의 항목
        const b = document.getElementById('qbShareItem'), r = b.getBoundingClientRect();
        const bar = document.querySelector('.appbar');
        const out = [...bar.querySelectorAll('button, a, summary'), ...document.querySelectorAll('#qbar > button')].filter(e => { const q = e.getBoundingClientRect(); return q.width > 0 && (q.right > window.innerWidth + 1 || q.left < -1); }).map(e => e.id || e.textContent.trim());
        return { coarse: matchMedia('(pointer: coarse)').matches, shown: !b.hidden && r.width > 0, label: b.textContent.trim(), out, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      });
      if (!st.coarse) { note(`${p}: 이 브라우저는 터치 흉내가 안 돼서 휴대폰 확인은 건너뜀`); continue; }
      coarseSeen = true;
      if (!st.shown) { fail(`${p}: 터치 기기(파일 공유 가능)인데 공유 버튼이 보이지 않아요`); continue; }
      const expectLabel = p.startsWith('/en/') ? 'Share' : '공유';
      if (st.label !== expectLabel) fail(`${p}: 공유 버튼 이름이 "${expectLabel}"가 아니라 "${st.label}"이에요`);
      if (st.out.length || st.wide) fail(`${p}: ${w}px 폭에서 맨 위 막대가 화면 밖으로 넘쳐요 (${st.out.join(', ') || '가로 스크롤'})`);
      await page.click('#qbShareItem');
      if (!await waitFor(page, () => !!window.__shared, 5000)) fail(`${p}: 공유 버튼을 눌렀는데 공유 시트로 넘기지 않았어요`);
      else {
        const s = await page.evaluate(() => window.__shared);
        if (s.n !== 1 || s.type !== 'image/png' || !/\.png$/.test(s.name) || s.size < 100) fail(`${p}: 공유한 파일이 PNG 도안 이미지가 아니에요 (${JSON.stringify(s)})`);
      }
      errors.forEach(e => fail(`${p}: ${e}`));
    } finally { await ctx.close(); }
  }
  note(coarseSeen ? 'PC 2곳, 휴대폰 2곳 확인' : 'PC 2곳 확인');
});

// 계산 함수 검사용 도안 "Li": 가로 10, 세로 12, 1단 = 맨 아래 줄, 가로 번호는 왼쪽부터 1
function filetLi() {
  const n = 10, R = 12, solid = new Array(n * R).fill(false);
  const set = (r1, r2, cs) => { for (let r = r1; r <= r2; r++) for (const c of cs) solid[(R - r) * n + c - 1] = true; };
  set(2, 11, [2, 3]); set(2, 3, [4, 5, 6]); set(2, 8, [8, 9]); set(10, 11, [8, 9]);
  return { cols: n, rows: R, solid };
}
const filetLayout = () => {
  const pv = document.getElementById('filetPreview').getBoundingClientRect(), ch = document.getElementById('filetChart').getBoundingClientRect();
  const note = getComputedStyle(document.getElementById('filetColorNote')).color, soft = getComputedStyle(document.querySelector('.filet-guide ul')).color;
  return { side: ch.left >= pv.right - 1 && Math.abs(ch.top - pv.top) < 80, stacked: ch.top >= pv.bottom - 1, noteSoft: note === soft };
};
test('방안뜨기 탭: 계산 공식, 탭 전환·설정·기호도·PNG, 편집 막힘, 360px·어두운 화면, 영어, 도안 데이터 그대로', async (fail, note) => {
  const LI = filetLi();
  // 1) 계산 함수 (화면과 따로)
  {
    const t = await openPage('/pattern/');
    try {
      const r = await t.page.evaluate(li => {
        const inv = { cols: li.cols, rows: li.rows, solid: li.solid.map(s => !s) };
        const all = (n, v) => ({ cols: n, rows: 3, solid: new Array(n * 3).fill(v) });
        const p = filetPlan(li, 'b'), q = filetPlan(inv, 'b');
        const pick = x => [x.startChain, x.firstStitchAt];
        return {
          b: [p.startChain, p.firstStitchAt, p.rowStitches, p.rowList[8].dir, filetRunsText(p.rowList[8].runs)],
          bi: [q.startChain, q.firstStitchAt, filetRunsText(q.rowList[8].runs)],
          a30: pick(filetPlan(all(30, false), 'a')), b25: pick(filetPlan(all(25, false), 'b')),
          c10e: pick(filetPlan(all(10, false), 'c')), c10s: pick(filetPlan(all(10, true), 'c')),
        };
      }, LI);
      const eq = (got, want, what) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${what}: ${JSON.stringify(want)}이어야 하는데 ${JSON.stringify(got)}이에요`); };
      eq(r.b, [35, 8, 31, 'rtl', '빈 칸 7, 막힌 칸 2, 빈 칸 1'], 'Li 버전 b (시작 사슬, 몇 번째, 한 줄 코수, 9단 방향, 9단 설명)');
      eq(r.bi, [33, 4, '막힌 칸 7, 빈 칸 2, 막힌 칸 1'], 'Li 뒤집기 후 버전 b');
      eq(r.a30, [64, 6], '버전 a 가로 30칸 빈 칸 시작');
      eq(r.b25, [80, 8], '버전 b 가로 25칸 빈 칸 시작');
      eq(r.c10e, [36, 9], '버전 c 가로 10칸 빈 칸 시작');
      eq(r.c10s, [34, 5], '버전 c 가로 10칸 막힌 칸 시작');
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  // 2) 화면: Li를 빨강으로, 1단 맨 오른쪽 칸만 파랑으로 칠한 도안 (맨 위 왼쪽 칸은 사람처럼 눌러서 빨강으로 → 되돌리기 기록이 생김)
  {
    const t = await openPage('/pattern/');
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'dotteugae-filet-'));
    try {
      const { page, ctx } = t;
      await page.evaluate((li, red, blue) => {
        rows = li.rows; cols = li.cols;
        gridData = li.solid.map(s => s ? red : null);
        gridData[(rows - 1) * cols + cols - 1] = blue;
        rowsInput.value = rows; colsInput.value = cols;
        sizeCanvas(); drawGrid(); saveState();
      }, LI, RED, BLUE);
      await pickColor(page, RED);
      await clickCell(page, 0, 0);
      await settle();
      const before = await page.evaluate(() => ({ store: localStorage.getItem('crochet-tool-v1'), data: JSON.stringify(gridData) }));
      const mode = () => page.evaluate(() => document.querySelector('.app').classList.contains('filet-mode'));
      const state = () => page.evaluate(() => {
        const p = filetCurrentPlan;
        const drawn = document.querySelectorAll('#filetChart .fc-up, #filetChart .fc-first, #filetChart .fc-base').length;
        return { start: p && p.startChain, at: p && p.firstStitchAt, drawn, text: document.getElementById('filetStart').innerText, label: [...document.querySelectorAll('#filetChart text')].map(x => x.textContent).filter(x => /시작 사슬/.test(x)) };
      });
      const expect = async (start, what) => {
        const s = await state();
        if (!await mode()) { fail(`${what}: 방안뜨기 탭이 아니에요`); return; }
        if (s.start !== start) fail(`${what}: 시작 사슬이 ${start}코여야 하는데 ${s.start}코예요`);
        if (s.drawn !== s.start) fail(`${what}: 기호도에 그린 사슬(세로 + 첫 빈 칸 + 가로)이 ${s.drawn}개인데 시작 사슬은 ${s.start}코예요`);
        if (s.label.length !== 1 || s.label[0] !== `시작 사슬 ${s.start}코`) fail(`${what}: 기호도 맨 아래에 "시작 사슬 ${s.start}코" 글자가 한 번 있어야 해요 (${JSON.stringify(s.label)})`);
        if (!s.text.includes(`사슬 ${s.start}코`) || !s.text.includes(`${s.at}번째`)) fail(`${what}: 시작 안내 글이 계산과 달라요 (${s.text.split('\n')[0]})`);
      };
      if (await mode()) fail('처음부터 방안뜨기 탭이에요');
      // 기존 "방안뜨기로 보기" 버튼 = 방안뜨기 탭으로 바로 가기
      await clickId(page, 'filetBtn');
      await expect(33, '처음 열었을 때 (빨강·파랑 = 막힌 칸)');
      const ui = await page.evaluate(() => {
        const vis = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0; };
        const rowParts = li => { if (!li) return null; const q = c => li.querySelector(c), cs = e => getComputedStyle(e);
          return { n: q('.fr-n').textContent, dir: q('.fr-dir').textContent, runs: q('.fr-runs').textContent, tail: q('.fr-tail').textContent,
            nPx: parseFloat(cs(q('.fr-n')).fontSize), nWeight: parseInt(cs(q('.fr-n')).fontWeight, 10), rPx: parseFloat(cs(q('.fr-runs')).fontSize), dPx: parseFloat(cs(q('.fr-dir')).fontSize) }; };
        return {
          colors: document.querySelectorAll('#filetColors input[type=checkbox]').length,
          note: !document.getElementById('filetColorNote').hidden,
          guide: [...document.querySelectorAll('#filetGuideList li')].map(l => l.textContent),
          startLines: document.querySelectorAll('#filetStart p').length,
          row9: rowParts(document.querySelector('#filetRows li:nth-child(9)')),
          row1: rowParts(document.querySelector('#filetRows li:nth-child(1)')),
          row2: rowParts(document.querySelector('#filetRows li:nth-child(2)')),
          rowLines: document.querySelectorAll('#filetRows li').length,
          ribbonOn: ['filetVerSel', 'filetInvertBtn', 'filetSaveImgBtn'].every(vis),
          editOff: ['qbar', 'qbPaint', 'qbUndo', 'qbSave', 'qbMore', 'toolPaintBtn', 'undoBtn', 'clearGridBtn', 'rot90Btn'].every(id => !vis(id)) && !document.querySelector('.inspector').getClientRects().length,
          canvasOff: getComputedStyle(document.querySelector('.canvas-wrap')).visibility === 'hidden',
          tabs: ['tabDesign', 'tabFilet'].map(id => document.getElementById(id).getAttribute('aria-selected')).join(),
        };
      });
      if (ui.colors !== 2) fail(`색 체크박스가 2개(빨강·파랑)여야 하는데 ${ui.colors}개예요`);
      if (!ui.note) fail('색이 2개인데 "방안뜨기는 보통 한 가지 실로…" 안내가 보이지 않아요');
      const wantGuide = ['검정 = 막힌 칸(한길긴뜨기 3코), 흰색 = 빈 칸(사슬 2코 + 한길긴뜨기 1코)', '홀수 단은 ←, 짝수 단은 →', '단 바꿀 때 세우는 사슬: 다음 첫 칸이 막힌 칸 3코, 빈 칸 5코'];
      if (JSON.stringify(ui.guide) !== JSON.stringify(wantGuide)) fail(`보는 법 카드가 짧은 3줄이 아니에요 (${JSON.stringify(ui.guide)})`);
      if (ui.startLines !== 2) fail(`시작 안내가 두 줄이어야 하는데 ${ui.startLines}줄이에요`);
      if (ui.rowLines !== 12) fail(`줄별 설명이 한 단에 한 줄(12줄)이어야 하는데 ${ui.rowLines}줄이에요`);
      const rp = r => r && [r.n, r.dir, r.runs, r.tail].join(' | ');
      if (rp(ui.row9) !== '9단 | ← 오른쪽에서 왼쪽 | 빈 7 · 막 2 · 빈 1 | (세우는 사슬 5)') fail(`줄별 설명 9단이 다르게 나와요 (${rp(ui.row9)})`);
      if (rp(ui.row1) !== '1단 | ← 오른쪽에서 왼쪽 | 막 1 · 빈 9 | (시작 사슬 33코)') fail(`줄별 설명 1단이 다르게 나와요 (${rp(ui.row1)})`);
      if (!ui.row2 || ui.row2.dir !== '→ 왼쪽에서 오른쪽') fail(`줄별 설명 2단의 방향이 → 왼쪽에서 오른쪽이 아니에요 (${ui.row2 && ui.row2.dir})`);
      if (ui.row9 && !(ui.row9.nPx >= ui.row9.rPx * 1.4 && ui.row9.nWeight >= 700 && ui.row9.dPx < ui.row9.rPx)) fail(`줄별 설명의 단 번호가 본문보다 크고 굵지 않아요 (번호 ${ui.row9.nPx}px/${ui.row9.nWeight}, 본문 ${ui.row9.rPx}px, 방향 ${ui.row9.dPx}px)`);
      if (!ui.ribbonOn) fail('방안뜨기 탭인데 작업창에 버전·뒤집기·저장이 보이지 않아요');
      if (!ui.editOff) fail('방안뜨기 탭인데 칠하기·되돌리기 같은 편집 도구나 오른쪽 패널이 아직 보여요');
      if (!ui.canvasOff) fail('방안뜨기 탭인데 도안 캔버스가 가려지지 않았어요');
      if (ui.tabs !== 'false,true') fail(`탭 선택 표시가 달라요 (${ui.tabs})`);
      const names = await page.evaluate(() => ({ tab: document.getElementById('tabFilet').textContent.trim(), btn: document.querySelector('#filetBtn span').textContent.trim(), guide: document.querySelector('.filet-guide-title').textContent.trim(), save: document.querySelector('#filetSaveImgBtn span').textContent.trim() }));
      const wantNames = { tab: '방안뜨기', btn: '방안뜨기로 보기', guide: '방안뜨기(filet) 도안 보는 법', save: '방안뜨기 이미지 저장' };
      if (JSON.stringify(names) !== JSON.stringify(wantNames)) fail(`한국어 이름이 방안뜨기로 바뀌지 않았어요 (${JSON.stringify(names)})`);
      const lay = await page.evaluate(filetLayout);
      if (!(await page.evaluate(() => document.getElementById('filetGuide').getBoundingClientRect().top >= document.querySelector('.filet-pair').getBoundingClientRect().bottom - 1))) fail('보는 법 카드가 도안(미리보기·기호도) 아래에 있지 않아요');
      if (!lay.side) fail('넓은 화면(1440px)인데 미리보기 격자(왼쪽)와 기호도(오른쪽)가 나란히 놓이지 않았어요');
      if (!lay.noteSoft) fail('"방안뜨기는 보통 한 가지 실로…" 문구가 기존 보조 글씨 색이 아니에요');
      // 편집 막힘: 캔버스가 있던 자리를 눌러도, 단축키(Ctrl+Z, Delete)를 눌러도 도안이 안 바뀜
      const pt = await cellPoint(page, 5, 5);
      await page.mouse.click(pt.x, pt.y); await sleep(150);
      await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(150);
      await page.keyboard.press('Delete'); await sleep(100);
      if ((await page.evaluate(() => JSON.stringify(gridData))) !== before.data) fail('방안뜨기 탭에서 누르기·Ctrl+Z·Delete로 도안 칸이 바뀌었어요');
      // 기호도 확대·축소·맞춤·전체 화면 (보는 방식만 바뀌고 사슬 수와 도안은 그대로)
      const zoomInfo = () => page.evaluate(() => { const s = document.querySelector('#filetChart svg'); return { w: s.getBoundingClientRect().width, label: document.getElementById('filetZoomVal').textContent, chains: document.querySelectorAll('#filetChart ellipse').length }; });
      const z1 = await zoomInfo();
      await clickId(page, 'filetZoomIn');
      const z2 = await zoomInfo();
      if (!(z2.w > z1.w * 1.2) || z2.label !== '125%') fail(`확대 버튼을 눌렀는데 기호도가 커지지 않았어요 (${z1.w} → ${z2.w}, ${z2.label})`);
      await clickId(page, 'filetZoomOut'); await clickId(page, 'filetZoomOut');
      const z3 = await zoomInfo();
      if (!(z3.w < z1.w * 0.9)) fail(`축소 버튼을 눌렀는데 기호도가 작아지지 않았어요 (${z3.w})`);
      await clickId(page, 'filetZoomFit');
      const z4 = await page.evaluate(() => ({ boxW: document.getElementById('filetChart').clientWidth, svgW: document.querySelector('#filetChart svg').getBoundingClientRect().width, over: document.getElementById('filetChart').scrollWidth - document.getElementById('filetChart').clientWidth }));
      if (z4.over > 2) fail(`맞춤을 눌렀는데 기호도가 상자보다 넓어서 가로로 밀려요 (${z4.over}px)`);
      await clickId(page, 'filetFullBtn');
      const fs1 = await page.evaluate(() => { const f = document.getElementById('filetChartFig'), r = f.getBoundingClientRect(); return { cls: f.classList.contains('filet-full'), covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, chains: document.querySelectorAll('#filetChart ellipse').length }; });
      if (!fs1.cls || !fs1.covers) fail('전체 화면 버튼을 눌렀는데 기호도가 화면을 가득 채우지 않았어요');
      if (fs1.chains !== z1.chains) fail('전체 화면으로 바꾸자 기호도의 사슬 수가 달라졌어요');
      await page.keyboard.press('Escape'); await sleep(300);
      const fs2 = await page.evaluate(() => ({ full: document.getElementById('filetChartFig').classList.contains('filet-full'), mode: document.querySelector('.app').classList.contains('filet-mode') }));
      if (fs2.full) fail('Esc를 눌러도 전체 화면이 닫히지 않아요');
      if (!fs2.mode) fail('전체 화면에서 Esc를 눌렀더니 방안뜨기 탭까지 닫혔어요 (전체 화면만 닫혀야 해요)');
      await clickId(page, 'filetZoomFit'); await page.evaluate(() => document.getElementById('filetZoomIn').click()); await page.evaluate(() => document.getElementById('filetZoomOut').click());
      // 줄별 설명은 접었다 펼 수 있음
      await page.click('#filetRowsFold > summary'); await sleep(100);
      if (await page.evaluate(() => document.getElementById('filetRowsFold').open)) fail('줄별 설명 제목을 눌러도 접히지 않아요');
      await page.click('#filetRowsFold > summary'); await sleep(100);
      if (!await page.evaluate(() => document.getElementById('filetRowsFold').open)) fail('줄별 설명 제목을 다시 눌러도 펼쳐지지 않아요');
      // 설정 바꾸기
      await page.evaluate(c => { document.querySelector(`#filetColors input[data-color="${c}"]`).click(); }, BLUE); await sleep(150);
      await expect(35, '파랑 체크를 끈 뒤');
      await clickId(page, 'filetInvertBtn');
      await expect(33, '전체 뒤집기 뒤');
      await page.select('#filetVerSel', 'a'); await sleep(150);
      await expect(23, '버전 a로 바꾼 뒤');
      await page.select('#filetVerSel', 'c'); await sleep(150);
      await expect(34, '버전 c로 바꾼 뒤');
      // PNG 저장
      const cdp = await page.createCDPSession();
      try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, browserContextId: ctx.id }); }
      catch (e) { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }); }
      await clickId(page, 'filetSaveImgBtn');
      let file = null;
      for (let i = 0; i < 50 && !file; i++) { await sleep(200); file = fs.readdirSync(dl).find(f => f.endsWith('.png')); }
      if (!file) fail("'방안뜨기 이미지 저장'을 눌렀는데 PNG 파일이 내려받아지지 않았어요");
      else {
        await sleep(300);
        const buf = fs.readFileSync(path.join(dl, file));
        if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504E47) fail(`내려받은 방안뜨기 도안 파일이 PNG가 아니에요 (${file})`);
        if (!/^방안뜨기도안_10x12_\d{8}\.png$/.test(file)) fail(`방안뜨기 도안 파일 이름 형식이 달라요 (${file})`);
        // 인쇄용: 바탕이 흰색, 맨 위에 글자(시작 안내)가 있고, 아래에 범례가 있음
        const png = await page.evaluate(async b64 => {
          const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const x = c.getContext('2d'); x.drawImage(img, 0, 0);
          const w = c.width, at = (a, b) => [...x.getImageData(a, b, 1, 1).data].slice(0, 3);
          const band = filetLastImage && filetLastImage.band ? filetLastImage.band.h : 0; // 사이트 주소 띠(기본 켜짐)는 그림 아래에 붙으므로 빼고 봄
          const h = c.height - band;
          const darkIn = (y0, hh) => { const d = x.getImageData(0, y0, w, hh).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) n++; return n; };
          return { w, h, band, bandColor: band ? at(1, c.height - 2) : null, corners: [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)], darkTop: darkIn(0, Math.min(h, 170)), darkBottom: darkIn(Math.max(0, h - 150), Math.min(h, 150)), meta: filetLastImage };
        }, buf.toString('base64'));
        if (!png.corners.every(c => c.join() === '255,255,255')) fail(`저장한 이미지의 바탕이 흰색이 아니에요 (네 모서리 ${JSON.stringify(png.corners)})`);
        if (!png.band || png.bandColor.join() !== '226,238,232') fail(`방안뜨기 이미지 저장에 사이트 주소 띠(기본 켜짐)가 없어요 (띠 ${png.band}px, 색 ${png.bandColor})`);
        if (png.darkTop < 200) fail(`저장한 이미지 맨 위에 시작 안내 글자가 보이지 않아요 (검은 점 ${png.darkTop}개)`);
        if (png.darkBottom < 80) fail(`저장한 이미지 아래쪽에 범례가 보이지 않아요 (검은 점 ${png.darkBottom}개)`);
        const head = (png.meta && png.meta.head || []).join(' / ');
        if (!png.meta || png.meta.head[0] !== '방안뜨기 도안' || !/가로 10칸 × 세로 12단/.test(head) || !/방식 c: 사슬 2 \+ 두길긴뜨기/.test(head)) fail(`저장 이미지 제목·크기·방식이 맞지 않아요 (${head})`);
        if (!/1단 시작: 사슬 34코를 뜨고, 바늘에서 5번째 사슬에 첫 두길긴뜨기/.test(head)) fail(`저장 이미지에 시작 안내가 없거나 계산과 달라요 (${head})`);
        if (!png.meta || !png.meta.legend.includes('기호 설명') || !png.meta.legend.includes('두길긴뜨기') || !png.meta.legend.includes('사슬')) fail(`저장 이미지 범례가 맞지 않아요 (${png.meta && png.meta.legend.join(' / ')})`);
        if (png.meta && png.meta.px < 18) fail(`저장 이미지의 줄 번호가 너무 작아요 (${png.meta.px}px)`);
      }
      // 보는 법 카드: 오늘은 보지 않기 → Esc로 도안 탭 → 다시 방안뜨기 탭이면 접혀 있음 → "보는 법"으로 펼침
      await clickId(page, 'filetGuideToday');
      await page.keyboard.press('Escape'); await sleep(200);
      if (await mode()) fail('Esc를 눌러도 도안 탭으로 돌아가지 않아요');
      if (await page.evaluate(() => getComputedStyle(document.querySelector('.canvas-wrap')).visibility === 'hidden')) fail('도안 탭으로 돌아왔는데 캔버스가 안 보여요');
      if (await page.evaluate(() => !document.getElementById('qbPaint').getClientRects().length)) fail('도안 탭으로 돌아왔는데 편집 도구(새 도구 막대)가 다시 보이지 않아요');
      await clickId(page, 'tabFilet');
      if (!await mode()) fail('방안뜨기 탭을 눌러도 방안뜨기 보기로 바뀌지 않아요');
      const g = await page.evaluate(() => ({ key: localStorage.getItem('crochet-filet-guide-hide'), guide: !document.getElementById('filetGuide').hidden, link: !document.getElementById('filetGuideOpen').hidden }));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(g.key || '')) fail(`'오늘은 보지 않기'가 crochet-filet-guide-hide에 날짜를 저장하지 않았어요 (${g.key})`);
      if (g.guide || !g.link) fail("'오늘은 보지 않기' 뒤에 다시 열었는데 보는 법 카드가 접혀 있지 않거나 '보는 법' 링크가 없어요");
      await clickId(page, 'filetGuideOpen');
      if (await page.evaluate(() => document.getElementById('filetGuide').hidden)) fail("'보는 법'을 눌러도 카드가 펼쳐지지 않아요");
      await clickId(page, 'tabDesign');
      if (await mode()) fail('도안 탭을 눌러도 도안으로 돌아가지 않아요');
      await settle();
      const after = await page.evaluate(() => ({ store: localStorage.getItem('crochet-tool-v1'), data: JSON.stringify(gridData) }));
      if (after.data !== before.data) fail('방안뜨기 탭을 보고 나온 뒤 도안 칸(gridData)이 바뀌었어요');
      if (after.store !== before.store) fail('방안뜨기 탭을 보고 나온 뒤 자동 저장(crochet-tool-v1) 내용이 바뀌었어요');
      // 되돌리기는 방안뜨기 탭을 보기 전과 똑같이 동작 (맨 위 왼쪽 칸 칠하기를 되돌림)
      await clickId(page, 'undoBtn');
      if ((await page.evaluate(() => gridData[0])) !== null) fail('방안뜨기 탭을 보고 나온 뒤 되돌리기가 동작하지 않아요');
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); fs.rmSync(dl, { recursive: true, force: true }); }
  }
  // 3) 휴대폰 360px + 어두운 화면, 그리고 영어 페이지
  for (const [p, w, dark] of [['/pattern/', 360, true], ['/en/pattern/', 390, false]]) {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    page.on('console', m => { if (m.type() === 'error') errors.push('콘솔 오류: ' + m.text().split('\n')[0]); });
    try {
      await page.setViewport({ width: w, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(d => {
        try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); if (d) localStorage.setItem('crochet-ui-theme', 'dark'); } catch (e) {}
      }, dark);
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
      await page.evaluate(li => {
        rows = li.rows; cols = li.cols; gridData = li.solid.map(s => s ? '#222222' : null);
        rowsInput.value = rows; colsInput.value = cols; sizeCanvas(); drawGrid();
      }, LI);
      await page.evaluate(() => document.getElementById('tabFilet').scrollIntoView());
      await page.click('#tabFilet'); await sleep(300);
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth, area = document.querySelector('.app');
        const inScroll = el => !!el.closest('.filet-scrollbox');
        const out = [...area.querySelectorAll('.ribbon *, .view-tabs *, #filetView *, .appbar *')].filter(e => !inScroll(e) && e.getClientRects().length)
          .filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > vw + 1 || b.left < -1); })
          .map(e => e.id || e.className || e.tagName);
        const verSel = document.getElementById('filetVerSel');
        return { open: area.classList.contains('filet-mode'), out: [...new Set(out)].slice(0, 6), wide: document.documentElement.scrollWidth - vw,
          ribbon: !!verSel.getClientRects().length,
          tabs: document.querySelector('.view-tab-list').innerText.replace(/\s+/g, ' '),
          start: document.getElementById('filetStart').innerText,
          text: document.getElementById('filetView').innerText + '\n' + [...document.querySelectorAll('.view-tabs')].map(e => e.innerText).join('\n') };
      });
      const label = `${p} ${w}px${dark ? ' 어두운 화면' : ''}`;
      {
        const pr = await page.evaluate(() => new Promise(res => makeFiletImage(async blob => {
          const bmp = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); const at = (a, b) => [...x.getImageData(a, b, 1, 1).data].slice(0, 3);
          res({ corners: [at(1, 1), at(c.width - 2, 1), at(1, c.height - 2), at(c.width - 2, c.height - 2)], meta: filetLastImage, theme: document.documentElement.getAttribute('data-theme') });
        })));
        if (dark && pr.theme !== 'dark') fail(`${label}: 어두운 화면 설정이 적용되지 않았어요 (${pr.theme})`);
        if (!pr.corners.every(c => c.join() === '255,255,255')) fail(`${label}: 저장 이미지 바탕이 흰색이 아니에요 (화면 모드와 상관없이 흰색이어야 해요: ${JSON.stringify(pr.corners)})`);
        const hd = pr.meta.head.join(' / ');
        if (p.startsWith('/en/')) {
          if (!/Crochet|Filet chart/.test(pr.meta.head[0]) || !/10 squares × 12 rows/.test(hd) || !/Style b: Ch 2 \+ dc/.test(hd) || !/Row 1: Chain 35, then work the first double crochet \(dc\) in the 8th chain/.test(hd)) fail(`${label}: 저장 이미지 머리말이 영어로 나오지 않아요 (${hd})`);
          if (!pr.meta.legend.includes('Symbols') || !pr.meta.legend.some(l => /chain \(ch\)/.test(l)) || (pr.meta.head.concat(pr.meta.legend).join(' ').match(/[가-힣]+/g) || []).length) fail(`${label}: 저장 이미지 범례가 영어가 아니거나 한국어가 섞였어요 (${pr.meta.legend.join(' / ')})`);
        } else if (pr.meta.head[0] !== '방안뜨기 도안' || !/1단 시작: 사슬 35코/.test(hd) || !/방식 b: 사슬 2 \+ 한길긴뜨기/.test(hd)) fail(`${label}: 저장 이미지 머리말이 맞지 않아요 (${hd})`);
      }
      if (!r.open) { fail(`${label}: 방안뜨기 탭이 열리지 않아요`); continue; }
      const lay = await page.evaluate(filetLayout);
      if (!lay.stacked) fail(`${label}: 좁은 화면인데 미리보기 격자와 기호도가 위아래로 놓이지 않았어요`);
      if (!lay.noteSoft) fail(`${label}: "방안뜨기는 보통 한 가지 실로…" 문구가 기존 보조 글씨 색이 아니에요`);
      if (!r.ribbon) fail(`${label}: 방안뜨기 탭인데 작업창의 버전 선택이 보이지 않아요 (작업창이 접혀 있어도 보여야 해요)`);
      if (r.out.length || r.wide > 1) fail(`${label}: 방안뜨기 탭이 화면 밖으로 넘쳐요 (${r.out.join(', ') || r.wide + 'px'})`);
      if (p.startsWith('/en/')) {
        if (r.tabs !== 'Pattern Filet') fail(`${label}: 탭 이름이 영어가 아니에요 (${r.tabs})`);
        if (!/^Row 1: Chain 35, then work the first double crochet \(dc\) in the 8th chain/.test(r.start)) fail(`${label}: 시작 안내가 영어로 나오지 않아요 (${r.start.split('\n')[0]})`);
        const ko = (r.text.match(/[가-힣]+/g) || []);
        if (ko.length) fail(`${label}: 영어 페이지 방안뜨기 탭에 한국어가 남아 있어요 (${[...new Set(ko)].slice(0, 6).join(', ')})`);
        // 영어 문구: 범례에 (US terms) 한 번, 세우는 사슬은 버전에 맞게 first dc / first tr, 'post'·'upright'는 쓰지 않음
        const en = () => page.evaluate(() => ({
          legend: document.getElementById('filetLegend').innerText, start: document.getElementById('filetStart').innerText,
          guide: [...document.querySelectorAll('#filetGuideList li')].map(l => l.textContent),
          row9: (li => li ? ['.fr-n', '.fr-dir', '.fr-runs', '.fr-tail'].map(c => li.querySelector(c).textContent).join(' | ') : null)(document.querySelector('#filetRows li:nth-child(9)')),
          all: document.getElementById('filetView').innerText + '\n' + [...document.querySelectorAll('.filet-tools')].map(e => e.innerText).join('\n') }));
        let e = await en();
        if (!/Foundation chain 35/.test(await page.evaluate(() => document.getElementById('filetChart').textContent))) fail(`${label}: 기호도 맨 아래에 "Foundation chain 35" 글자가 없어요`);
        if ((e.legend.match(/\(US terms\)/g) || []).length !== 1) fail(`${label}: 기호 설명에 "(US terms)"가 한 번 있어야 해요 (${e.legend.replace(/\n/g, ' / ')})`);
        if (!e.legend.includes('counts as first dc')) fail(`${label}: 한길긴뜨기 버전 기호 설명에 "counts as first dc"가 없어요`);
        if (!e.start.includes('35 ch = turning chain (3 ch) on the right + 2 ch for the first space + 30 ch along the bottom')) fail(`${label}: 시작 사슬 설명이 새 문구가 아니에요 (${e.start.split('\n')[1]})`);
        if (e.guide.length !== 3 || e.guide[0] !== 'Black = block (3 dc), white = space (ch 2 + 1 dc)' || e.guide[1] !== 'Odd rows ←, even rows →' || e.guide[2] !== 'Turning chain: 3 if the next row starts with a block, 5 if with a space') fail(`${label}: 보는 법 영어가 달라요 (${JSON.stringify(e.guide)})`);
        if (e.row9 !== 'Row 9 | ← right to left | sp 7 · bl 2 · sp 1 | (turn ch 5)') fail(`${label}: 줄별 설명 영어가 달라요 (${e.row9})`);
        if (/\bposts?\b|upright/i.test(e.all)) fail(`${label}: 방안뜨기 탭 영어에 "post"나 "upright"가 남아 있어요`);
        await page.select('#filetVerSel', 'c'); await sleep(200);
        e = await en();
        if (!e.legend.includes('treble crochet (tr) (US terms)') || !e.legend.includes('counts as first tr')) fail(`${label}: 두길긴뜨기 버전 기호 설명이 tr에 맞지 않아요 (${e.legend.replace(/\n/g, ' / ')})`);
        if (!e.start.includes('36 ch = turning chain (4 ch) on the right + 2 ch for the first space + 30 ch along the bottom')) fail(`${label}: 두길긴뜨기 1단 세로 사슬 4코가 맞게 나오지 않아요 (${e.start.split('\n')[1]})`);
        if (/\bposts?\b|upright/i.test(e.all) || e.guide[0] !== 'Black = block (3 tr), white = space (ch 2 + 1 tr)') fail(`${label}: 두길긴뜨기 버전 보는 법·설명에 tr 문구가 맞지 않아요`);
      } else if (!/^1단 시작: 사슬 35코/.test(r.start)) fail(`${label}: 시작 안내가 이상해요 (${r.start.split('\n')[0]})`);
      errors.forEach(e => fail(`${label}: ${e}`));
    } finally { await ctx.close(); }
  }
  note('계산 6가지, 탭 전환·편집 막힘·설정 5단계, 휴대폰·영어 2곳');
});

test('시작 화면: 빈 도안에서만 보임, 카드 세 개 동작, 링크·저장된 도안·파일 열기면 건너뜀, 휴대폰·영어', async (fail, note) => {
  const isStart = page => page.evaluate(() => document.querySelector('.app').classList.contains('start-mode') && !document.getElementById('startScreen').hidden);
  const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }, sel);
  // 1) 처음 온 사람(PC): 시작 화면이 보이고, 맨 위 막대는 그대로 쓸 수 있음 → "빈 격자로 시작"
  {
    const t = await openPage('/pattern/', { keepStart: true });
    try {
      const { page } = t;
      if (!await isStart(page)) fail('처음 온 사람(빈 도안)인데 시작 화면이 보이지 않아요');
      const cards = await Promise.all(['#startBlank', '#startText', '#startExample'].map(s => vis(page, s)));
      if (!cards.every(Boolean)) fail(`시작 화면의 카드 세 개가 다 보이지 않아요 (${cards.join(',')})`);
      const textCard = await page.evaluate(() => document.querySelector('#startText .start-t span').textContent);
      const ord = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('.start-choices > .start-card')].map(e => e.id);
        const r = ids.map(id => document.getElementById(id).getBoundingClientRect().left);
        const t = document.getElementById('startText'), b = t.querySelector('.start-badge'), tr = t.getBoundingClientRect(), br = b ? b.getBoundingClientRect() : null;
        return { ids, leftToRight: r[0] < r[1] && r[1] < r[2], main: t.classList.contains('main') && !document.getElementById('startBlank').classList.contains('main'),
          badge: b ? b.textContent.trim() : null, badgeIn: !!br && br.left >= tr.left && br.right <= tr.right && br.top >= tr.top, blank: document.querySelector('#startBlank .start-t span').textContent };
      });
      if (ord.ids.join() !== 'startText,startBlank,startExample' || !ord.leftToRight) fail(`시작 화면 카드 순서가 "글자로 시작 → 빈 격자로 시작 → 예시 도안 열기"가 아니에요 (${ord.ids.join(', ')})`);
      if (!ord.main) fail('"글자로 시작" 카드만 강조되어 있어야 해요');
      if (ord.badge !== '추천' || !ord.badgeIn) fail(`"글자로 시작" 카드에 "추천" 뱃지가 카드 안에 없어요 (${ord.badge})`);
      if (ord.blank !== '칸을 하나씩 칠해서 직접 그려요.') fail(`"빈 격자로 시작" 카드 설명이 새 문구가 아니에요 (${ord.blank})`);
      if (textCard !== '이름이나 문구를 넣으면 바로 도안이 돼요. 방안뜨기(filet)로도 바꿀 수 있어요.') fail(`"글자로 시작" 카드 설명이 새 문구가 아니에요 (${textCard})`);
      if (await vis(page, '.ribbon') || await vis(page, '#qbar') || await vis(page, '#gridCanvas')) fail('시작 화면인데 도구 막대나 격자가 함께 보여요');
      if (!await vis(page, '#langBtn') || !await vis(page, '#themeBtn') || !(await vis(page, '.tool-nav') || await vis(page, '.tool-menu'))) fail('시작 화면에서 맨 위 메뉴·EN·화면 모드 버튼이 안 보여요');
      const HIDE = ['saveFileBtn', 'undoBtn', 'redoBtn', 'saveImgBtn', 'shareImgBtn'];
      const shown = ids => Promise.all(ids.map(id => vis(page, '#' + id)));
      const sh = await shown(HIDE);
      if (sh.some(Boolean)) fail(`시작 화면인데 맨 위 막대에 저장·되돌리기·다시하기·이미지 저장·공유가 보여요 (${HIDE.filter((id, i) => sh[i]).join(', ')})`);
      if (!await vis(page, '#openFileBtn')) fail('시작 화면에서 열기 버튼이 안 보여요');
      if ((await page.evaluate(() => localStorage.getItem('crochet-tool-v1'))) !== null) fail('시작 화면이 뜨면서 자동 저장(crochet-tool-v1)에 무언가를 썼어요');
      const th0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await clickId(page, 'themeBtn');
      if ((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === th0) fail('시작 화면에서 화면 모드 버튼이 동작하지 않아요');
      if (!await isStart(page)) fail('화면 모드를 바꾸자 시작 화면이 닫혔어요');
      await clickId(page, 'startBlank');
      if (await isStart(page)) fail('"빈 격자로 시작"을 눌러도 시작 화면이 닫히지 않아요');
      const g = await page.evaluate(() => ({ w: document.getElementById('gridCanvas').getBoundingClientRect().width, empty: !gridData.some(Boolean), rows, cols, ribbon: document.getElementById('qbar').getClientRects().length > 0 }));
      // 4단계: 저장(도안 파일·이미지)·되돌리기·다시하기는 새 도구 막대에 있음
      const back = await shown(['qbSave', 'qbUndo', 'qbRedo', 'qbOpen']);
      if (!back.every(Boolean)) fail(`시작 화면을 닫았는데 저장·되돌리기·다시하기·열기가 다시 보이지 않아요 (${back.join(',')})`);
      if (!(await page.evaluate(() => ['saveFileBtn', 'saveImgBtn'].every(id => !!document.querySelector('#qbSaveMenu .qb-mi[data-click="' + id + '"]'))))) fail('시작 화면을 닫았는데 저장 메뉴에 도안 파일 저장·이미지로 저장이 없어요');
      if (!(g.w > 100) || !g.ribbon) fail('"빈 격자로 시작" 뒤에 격자나 작업창이 보이지 않아요');
      if (!g.empty || g.rows !== 20 || g.cols !== 20) fail(`"빈 격자로 시작" 뒤의 격자가 지금 격자(20×20 빈 격자)가 아니에요 (${g.cols}×${g.rows})`);
      await clickCell(page, 0, 0);
      if (!(await page.evaluate(() => !!gridData[0]))) fail('"빈 격자로 시작" 뒤에 칸을 칠할 수 없어요');
      // 칠한 도안이 있는 재방문: 새로고침하면 시작 화면 없이 바로 작업 화면
      await settle();
      await page.reload({ waitUntil: 'networkidle0' }); await sleep(200);
      if (await isStart(page)) fail('칠한 도안이 저장된 채로 다시 왔는데 시작 화면이 떠요');
      if (!(await page.evaluate(() => !!gridData[0]))) fail('다시 왔을 때 칠한 칸이 그대로가 아니에요');
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  // 2) "글자로 시작": 글자 탭이 열리고 글자 입력칸에 커서
  {
    const t = await openPage('/pattern/', { keepStart: true });
    try {
      await clickId(t.page, 'startText');
      const r = await t.page.evaluate(() => ({ pane: document.getElementById('pane-text').classList.contains('active'), focus: document.activeElement && document.activeElement.id }));
      if (await isStart(t.page)) fail('"글자로 시작"을 눌러도 시작 화면이 닫히지 않아요');
      if (!r.pane) fail('"글자로 시작" 뒤에 글자 탭이 열리지 않았어요');
      if (r.focus !== 'textInput') fail(`"글자로 시작" 뒤에 글자 입력칸에 커서가 없어요 (${r.focus})`);
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  // 3) "예시 도안 열기": 한국어는 /examples/, 영어는 영어 홈의 예시 구역 /en/#examples
  for (const [p, wantPath, wantHash] of [['/pattern/', '/examples/', ''], ['/en/pattern/', '/en/', '#examples']]) {
    const t = await openPage(p, { keepStart: true });
    try {
      const { page } = t;
      if (!await isStart(page)) { fail(`${p}: 빈 도안인데 시작 화면이 보이지 않아요`); continue; }
      if (p.startsWith('/en/')) {
        const en = await page.evaluate(() => ({ title: document.getElementById('startTitle').textContent, text: document.getElementById('startScreen').innerText }));
        if (!en.text.includes('Recommended') || !en.text.includes('Paint the grid square by square.')) fail(`${p}: 영어 시작 화면의 뱃지나 "Start with a blank grid" 설명이 새 문구가 아니에요`);
        if (!en.text.includes('Type a name or phrase and it becomes a chart right away. You can switch it to filet, too.')) fail(`${p}: "Start with text" 카드 설명이 새 영어 문구가 아니에요`);
        if (en.title !== 'How would you like to start?') fail(`${p}: 시작 화면 제목이 영어가 아니에요 (${en.title})`);
        const ko = en.text.match(/[가-힣]+/g);
        if (ko) fail(`${p}: 시작 화면에 한국어가 남아 있어요 (${[...new Set(ko)].slice(0, 5).join(', ')})`);
      }
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }), page.click('#startExample')]);
      const u = new URL(page.url());
      if (u.pathname !== wantPath || u.hash !== wantHash) fail(`${p}: "예시 도안 열기"가 ${wantPath}${wantHash}로 가지 않아요 (${u.pathname}${u.hash})`);
      if (wantHash && !(await page.evaluate(h => !!document.querySelector(h), wantHash))) fail(`${p}: 영어 홈에 ${wantHash} 구역이 없어요`);
      t.errors.forEach(e => fail(`${p}: ${e}`));
    } finally { await t.close(); }
  }
  // 4) 예시 페이지의 "고쳐보기" 링크(#p=)로 열면 시작 화면 없이 그 도안
  {
    const html = fs.readFileSync(path.join(ROOT, 'examples', 'index.html'), 'utf8');
    const m = html.match(/#p=([A-Za-z0-9_-]+)/);
    if (!m) fail('예시 페이지에서 #p= 링크를 찾지 못했어요');
    else {
      const t = await openPage('/pattern/#p=' + m[1], { keepStart: true });
      try {
        if (await isStart(t.page)) fail('#p= 링크로 열었는데 시작 화면이 떠요');
        if (!(await t.page.evaluate(() => gridData.some(Boolean)))) fail('#p= 링크로 연 도안이 보이지 않아요');
        t.errors.forEach(e => fail(e));
      } finally { await t.close(); }
    }
  }
  // 5) 시작 화면이 떠 있을 때 도안 파일을 열면 시작 화면이 닫히고 그 도안
  {
    const dir = path.join(ROOT, 'examples', 'img');
    const json = fs.readdirSync(dir).find(f => f.endsWith('.json'));
    const t = await openPage('/pattern/', { keepStart: true });
    try {
      const input = await t.page.$('#openFileInput');
      await input.uploadFile(path.join(dir, json));
      if (!await waitFor(t.page, () => !document.querySelector('.app').classList.contains('start-mode') && gridData.some(Boolean), 5000)) fail(`시작 화면에서 도안 파일(${json})을 열었는데 시작 화면이 닫히지 않거나 도안이 안 보여요`);
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  // 6) 휴대폰 360px: 카드가 세로로 쌓이고 넘치지 않음
  {
    const t = await openPage('/pattern/', { keepStart: true, width: 360, height: 740, mobile: true });
    try {
      const r = await t.page.evaluate(() => {
        const rs = ['startText', 'startBlank', 'startExample'].map(id => document.getElementById(id).getBoundingClientRect());
        const bd = document.querySelector('#startText .start-badge').getBoundingClientRect(), tt = document.querySelector('#startText .start-t').getBoundingClientRect();
        const v = id => { const e = document.getElementById(id); return !!e && e.getClientRects().length > 0; };
        return { badgeOk: bd.right <= rs[0].right && bd.left >= rs[0].left && bd.top >= rs[0].top && (bd.bottom <= tt.top || bd.left >= tt.right), hid: ['saveFileBtn', 'undoBtn', 'redoBtn', 'saveImgBtn', 'shareImgBtn'].filter(v), open: v('openFileBtn'), theme: v('themeBtn'), stacked: rs[1].top >= rs[0].bottom - 1 && rs[2].top >= rs[1].bottom - 1 && Math.abs(rs[0].left - rs[2].left) < 2, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, lang: document.getElementById('langBtn').getClientRects().length > 0 };
      });
      if (!await isStart(t.page)) fail('360px: 빈 도안인데 시작 화면이 보이지 않아요');
      if (!r.stacked) fail('360px: 시작 화면 카드가 "글자로 시작"부터 세로로 쌓이지 않았어요');
      if (!r.badgeOk) fail('360px: "추천" 뱃지가 카드 밖으로 넘치거나 글자와 겹쳐요');
      if (r.over > 1) fail(`360px: 시작 화면이 옆으로 ${r.over}px 넘쳐요`);
      if (!r.lang) fail('360px: 시작 화면에서 EN 버튼이 안 보여요');
      if (r.hid.length) fail(`360px: 시작 화면인데 맨 위 막대에 ${r.hid.join(', ')}가 보여요`);
      if (!r.open || !r.theme) fail('360px: 시작 화면에서 열기나 화면 모드 버튼이 안 보여요');
      await clickId(t.page, 'startBlank');
      if (!(await t.page.evaluate(() => document.getElementById('qbSave').getClientRects().length > 0))) fail('360px: 시작 화면을 닫았는데 저장(이미지 내려받기가 든 메뉴) 버튼이 다시 보이지 않아요');
      t.errors.forEach(e => fail(`360px: ${e}`));
    } finally { await t.close(); }
  }
  note('빈 도안·글자로 시작·예시(한·영)·#p= 링크·재방문·파일 열기·360px');
});

test('색이 많을 때 안내: 5색 없음·6색 나옴·닫기·색이 줄면 사라짐, 방안뜨기 탭에서는 없음, 파일 열기·글자 넣기, 영어, 휴대폰', async (fail, note) => {
  const KO6 = '색이 6개예요. 색이 많으면 실을 갈아 끼우는 횟수가 늘어 뜨기 어려울 수 있어요.';
  const COLORS = ['#222222', '#D32F2F', '#FBC02D', '#1976D2', '#388E3C', '#8E24AA', '#00ACC1', '#F57C00'];
  const noteOf = page => page.evaluate(() => { const e = document.getElementById('colorNote'); return { shown: e.getClientRects().length > 0, text: document.getElementById('colorNoteText').textContent, n: usedColorCount() }; });
  const settleNote = () => sleep(350);
  // 1) 사람처럼 칠하기·되돌리기·다시하기·닫기 (한국어)
  {
    const t = await openPage('/pattern/');
    try {
      const { page } = t;
      await page.evaluate(cs => { PRESET_COLORS.length = 0; cs.forEach(c => PRESET_COLORS.push(c)); buildPalette(); }, COLORS);
      await settleNote();
      const paint = async (k) => { await pickColor(page, COLORS[k]); await clickCell(page, 0, k); await settleNote(); };
      const gd0 = await page.evaluate(() => JSON.stringify(gridData));
      for (let k = 0; k < 5; k++) await paint(k);
      let s = await noteOf(page);
      if (s.shown || s.n !== 5) fail(`5색인데 안내가 보여요 (색 ${s.n}개, 보임 ${s.shown})`);
      // 배경색으로 칠한 칸과, 팔레트에만 있고 칠하지 않은 색(6~8번째)은 세지 않음
      await page.evaluate(() => { gridData[10] = bgColor; drawGrid(); }); await settleNote();
      s = await noteOf(page);
      if (s.shown || s.n !== 5) fail(`배경색 칸이나 칠하지 않은 팔레트 색을 센 것 같아요 (색 ${s.n}개, 보임 ${s.shown})`);
      await page.evaluate(() => { gridData[10] = null; drawGrid(); });
      await paint(5);
      s = await noteOf(page);
      if (!s.shown || s.n !== 6) fail(`6색을 칠했는데 안내가 안 나와요 (색 ${s.n}개, 보임 ${s.shown})`);
      if (s.text !== KO6) fail(`안내 문구가 달라요 (${s.text})`);
      await paint(6);
      s = await noteOf(page);
      if (!s.shown || !s.text.startsWith('색이 7개예요.')) fail(`7색인데 안내 문구의 개수가 7이 아니에요 (${s.text})`);
      await clickId(page, 'undoBtn'); await settleNote();
      s = await noteOf(page);
      if (!s.shown || s.n !== 6 || !s.text.startsWith('색이 6개예요.')) fail(`되돌리기 뒤 색 개수(6)와 안내가 다시 계산되지 않았어요 (색 ${s.n}개, ${s.text})`);
      await clickId(page, 'undoBtn'); await settleNote();
      s = await noteOf(page);
      if (s.shown || s.n !== 5) fail(`색이 5개로 줄었는데 안내가 안 사라졌어요 (색 ${s.n}개, 보임 ${s.shown})`);
      await clickId(page, 'redoBtn'); await settleNote();
      s = await noteOf(page);
      if (!s.shown || s.n !== 6) fail(`다시하기 뒤 안내가 다시 나오지 않았어요 (색 ${s.n}개)`);
      // 닫기: 닫으면 사라지고, 색이 더 늘어도 안 나옴. 5개 이하로 줄었다가 다시 6개가 되면 또 나옴
      await clickId(page, 'colorNoteClose');
      if ((await noteOf(page)).shown) fail('닫기(x)를 눌러도 안내가 사라지지 않아요');
      await clickId(page, 'redoBtn'); await settleNote();
      s = await noteOf(page);
      if (s.shown || s.n !== 7) fail(`닫은 뒤 색이 더 늘었는데 안내가 다시 나와요 (색 ${s.n}개, 보임 ${s.shown})`);
      await clickId(page, 'undoBtn'); await clickId(page, 'undoBtn'); await settleNote();
      await clickId(page, 'redoBtn'); await settleNote();
      s = await noteOf(page);
      if (!s.shown || s.n !== 6) fail(`5색 이하로 줄었다가 다시 6색이 됐는데 안내가 다시 나오지 않아요 (색 ${s.n}개, 보임 ${s.shown})`);
      // 방안뜨기 탭에서는 안 보이고, 도안 탭으로 돌아오면 다시 보임
      await clickId(page, 'tabFilet');
      if ((await noteOf(page)).shown) fail('방안뜨기 탭인데 색이 많다는 안내가 보여요');
      await clickId(page, 'tabDesign'); await settleNote();
      if (!(await noteOf(page)).shown) fail('방안뜨기 탭에서 도안 탭으로 돌아왔는데 안내가 다시 보이지 않아요');
      // 안내는 보이기만 함: 저장된 내용에 안내 관련 항목이 없음
      const store = await page.evaluate(() => localStorage.getItem('crochet-tool-v1') || '');
      if (/colorNote|dismiss/i.test(store)) fail('안내 상태가 자동 저장(crochet-tool-v1)에 들어갔어요');
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  // 2) 글자 넣기 뒤 개수 다시 계산 + 파일 열기
  {
    const t = await openPage('/pattern/');
    const tmp = path.join(os.tmpdir(), 'dotteugae-colors-' + process.pid + '.json');
    try {
      const { page } = t;
      await page.evaluate(cs => { PRESET_COLORS.length = 0; cs.forEach(c => PRESET_COLORS.push(c)); buildPalette(); }, COLORS);
      for (let k = 0; k < 5; k++) { await pickColor(page, COLORS[k]); await clickCell(page, 0, k); }
      await pickColor(page, COLORS[5]);
      await page.click('.insp-tab[data-pane="text"]'); await sleep(150);
      await page.click('#textInput', { clickCount: 3 });
      await page.type('#textInput', '뜨');
      if (!await waitFor(page, () => !!stamp, 10000)) fail('글자 넣기: 문구를 넣었는데 미리보기 글자가 나타나지 않았어요');
      await clickId(page, 'convertBtn'); await sleep(900);
      if (await page.evaluate(() => !!(stamp && stamp.isText))) await clickId(page, 'stampPlaceBtn');
      await settleNote();
      const s = await noteOf(page);
      if (s.n < 6 || !s.shown) fail(`6번째 색으로 글자를 넣었는데 색 개수가 다시 계산되지 않았어요 (색 ${s.n}개, 보임 ${s.shown})`);
      // 파일 열기: 색 7개짜리 도안 파일
      const colors = COLORS.slice(0, 7);
      fs.writeFileSync(tmp, JSON.stringify({ app: 'crochet-pattern-tool', version: 1, cols: 7, rows: 1, bg: '#FFFFFF', colors, cells: colors.map((c, i) => [i + 1, 1]) }));
      await (await page.$('#openFileInput')).uploadFile(tmp);
      if (!await waitFor(page, () => cols === 7 && rows === 1, 5000)) fail('색이 7개인 도안 파일이 열리지 않았어요');
      await settleNote();
      const f = await noteOf(page);
      if (!f.shown || !f.text.startsWith('색이 7개예요.')) fail(`파일을 열었는데 7색 안내가 나오지 않아요 (색 ${f.n}개, ${f.text})`);
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); try { fs.unlinkSync(tmp); } catch (e) {} }
  }
  // 3) 영어 페이지
  {
    const t = await openPage('/en/pattern/');
    try {
      const { page } = t;
      const setN = n => page.evaluate((n, cs) => { rows = 2; cols = 8; gridData = new Array(16).fill(null); cs.slice(0, n).forEach((c, i) => { gridData[i] = c; }); sizeCanvas(); drawGrid(); }, n, COLORS);
      await setN(5); await settleNote();
      if ((await noteOf(page)).shown) fail('/en/pattern/: 5색인데 안내가 보여요');
      await setN(6); await settleNote();
      let s = await noteOf(page);
      if (!s.shown || s.text !== 'This pattern uses 6 colors. More colors mean more yarn changes, which can make it harder to crochet.') fail(`/en/pattern/: 6색 영어 안내가 달라요 (${s.shown}, ${s.text})`);
      await setN(8); await settleNote();
      s = await noteOf(page);
      if (!s.text.startsWith('This pattern uses 8 colors.')) fail(`/en/pattern/: 영어 안내의 개수가 8이 아니에요 (${s.text})`);
      if (/[가-힣]/.test(s.text)) fail('/en/pattern/: 영어 안내에 한국어가 섞였어요');
      await setN(3); await settleNote();
      if ((await noteOf(page)).shown) fail('/en/pattern/: 색이 3개로 줄었는데 안내가 안 사라졌어요');
      t.errors.forEach(e => fail(`/en/pattern/: ${e}`));
    } finally { await t.close(); }
  }
  // 4) 휴대폰 폭(320·360·390): 안내가 넘치거나 잘리지 않음 (어두운 화면, 한국어·영어)
  for (const [p, w, dark] of [['/pattern/', 320, true], ['/pattern/', 360, true], ['/en/pattern/', 390, true], ['/pattern/', 390, false]]) {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    try {
      await page.setViewport({ width: w, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(d => { try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); if (d) localStorage.setItem('crochet-ui-theme', 'dark'); } catch (e) {} }, dark);
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
      await page.evaluate(cs => { rows = 3; cols = 8; gridData = new Array(24).fill(null); cs.forEach((c, i) => { gridData[i] = c; }); sizeCanvas(); drawGrid(); }, COLORS);
      await settleNote();
      const r = await page.evaluate(() => {
        const e = document.getElementById('colorNote'), b = document.getElementById('colorNoteClose'), tx = document.getElementById('colorNoteText'), vw = document.documentElement.clientWidth;
        const er = e.getBoundingClientRect(), br = b.getBoundingClientRect(), tr = tx.getBoundingClientRect();
        return { shown: e.getClientRects().length > 0, inView: er.left >= -0.5 && er.right <= vw + 0.5, btnIn: br.left >= 0 && br.right <= vw && br.width > 0, textIn: tr.right <= br.left + 1, clipped: tx.scrollWidth > tx.clientWidth + 1, over: document.documentElement.scrollWidth - vw, h: Math.round(er.height), theme: document.documentElement.getAttribute('data-theme') };
      });
      const label = `${p} ${w}px${dark ? ' 어두운 화면' : ''}`;
      if (!r.shown) { fail(`${label}: 8색인데 안내가 보이지 않아요`); continue; }
      if (dark && r.theme !== 'dark') fail(`${label}: 어두운 화면이 적용되지 않았어요 (${r.theme})`);
      if (!r.inView || !r.btnIn || !r.textIn || r.clipped) fail(`${label}: 안내가 화면 밖으로 넘치거나 글자가 잘려요 (${JSON.stringify(r)})`);
      if (r.over > 1) fail(`${label}: 안내 때문에 가로로 ${r.over}px 넘쳐요`);
      errors.forEach(e => fail(`${label}: ${e}`));
    } finally { await ctx.close(); }
  }
  note('칠하기·되돌리기·다시하기·닫기·글자 넣기·파일 열기, 방안뜨기 탭, 영어, 휴대폰 4곳');
});

test('최근에 쓴 색: 순서·중복·6개 한도·새로고침 유지·누르면 선택·팔레트에서 지우면 빠짐, 저장소 오류, 영어, 휴대폰', async (fail, note) => {
  const COLORS = ['#222222', '#D32F2F', '#FBC02D', '#1976D2', '#388E3C', '#8E24AA', '#00ACC1', '#F57C00'];
  const recent = page => page.evaluate(() => {
    const row = document.getElementById('qbRecentRow'); // 4단계: 화면에 보이는 최근 줄은 새 도구 막대에 있음
    return { chips: [...document.querySelectorAll('#qbRecentChips .recent-chip')].map(b => b.dataset.color), shown: !row.hidden && row.getClientRects().length > 0,
      active: activeColor, sel: [...document.querySelectorAll('#qbRecentChips .recent-chip.selected')].map(b => b.dataset.color),
      store: (() => { try { return localStorage.getItem('crochet-recent-colors'); } catch (e) { return null; } })(), label: document.querySelector('.recent-label').textContent,
      names: [...document.querySelectorAll('#qbRecentChips .recent-chip')].map(b => b.getAttribute('aria-label')) };
  });
  const setPalette = page => page.evaluate(cs => { PRESET_COLORS.length = 0; cs.forEach(c => PRESET_COLORS.push(c)); activeColor = PRESET_COLORS[0]; buildPalette(); }, COLORS);
  const eq = (got, want, what) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail(what + ': ' + JSON.stringify(want) + '이어야 하는데 ' + JSON.stringify(got) + '이에요'); };
  const pick = async (page, ...idx) => { for (const k of idx) { await pickColor(page, COLORS[k]); await sleep(120); } };
  // 1) 한국어 PC
  {
    const t = await openPage('/pattern/');
    try {
      const { page } = t;
      await setPalette(page);
      const ribbonH = () => page.evaluate(() => Math.round(document.querySelector('.ribbon').getBoundingClientRect().height));
      let r = await recent(page);
      if (r.shown || r.chips.length) fail('처음 열었는데 "최근" 줄이 보여요');
      const h0 = await ribbonH();
      await pick(page, 1);
      r = await recent(page);
      eq(r.chips, [COLORS[1], COLORS[0]], '색을 하나 고른 뒤 최근 목록(바꾸기 전에 쓰던 색도 들어감)');
      await pick(page, 2, 3);
      r = await recent(page);
      eq(r.chips, [COLORS[3], COLORS[2], COLORS[1], COLORS[0]], '색 3개를 고른 뒤 최근 목록 순서');
      if (!r.shown) fail('최근 색이 여럿인데 "최근" 줄이 안 보여요');
      if (r.label !== '최근') fail('"최근" 라벨이 아니에요 (' + r.label + ')');
      eq(r.sel, [COLORS[3]], '지금 고른 색의 선택 표시');
      if (r.names.some(n => !n || !/^최근 색 #[0-9A-F]{6}$/.test(n))) fail('최근 색 버튼의 접근성 이름이 없거나 형식이 달라요 (' + r.names.join(', ') + ')');
      const h1 = await ribbonH();
      if (Math.abs(h1 - h0) > 1) fail('"최근" 줄이 생기면서 작업창이 두꺼워졌어요 (' + h0 + 'px → ' + h1 + 'px)');
      // 최근 색을 누르면 그 색이 칠할 색이 됨 + 맨 앞으로, 중복 없음
      await page.click('#qbRecentChips .recent-chip[data-color="' + COLORS[1] + '"]'); await sleep(150);
      r = await recent(page);
      eq(r.chips, [COLORS[1], COLORS[3], COLORS[2], COLORS[0]], '같은 색을 다시 고른 뒤(맨 앞으로, 중복 없음)');
      if (r.active !== COLORS[1]) fail('최근 색을 눌렀는데 칠할 색이 바뀌지 않았어요 (' + r.active + ')');
      eq(r.sel, [COLORS[1]], '최근 색을 누른 뒤 선택 표시');
      await clickCell(page, 0, 0);
      if ((await page.evaluate(() => gridData[0])) !== COLORS[1]) fail('최근 색을 누른 뒤 칠했는데 그 색으로 칠해지지 않았어요');
      // 7개째 색: 6개 유지, 가장 오래된 색이 빠짐
      await pick(page, 4, 5, 6);
      r = await recent(page);
      eq(r.chips, [COLORS[6], COLORS[5], COLORS[4], COLORS[1], COLORS[3], COLORS[2]], '색을 더 골라 6개를 넘겼을 때(7번째부터 가장 오래된 색이 빠짐)');
      if (new Set(r.chips).size !== r.chips.length) fail('최근 목록에 같은 색이 두 번 있어요');
      eq(JSON.parse(r.store || 'null'), r.chips, '저장된 crochet-recent-colors 내용');
      const tool = await page.evaluate(() => localStorage.getItem('crochet-tool-v1') || '');
      if (/recent/i.test(tool)) fail('최근 색이 자동 저장(crochet-tool-v1)에 들어갔어요');
      // 새로고침 뒤에도 유지
      await settle();
      await page.reload({ waitUntil: 'networkidle0' }); await sleep(250);
      r = await recent(page);
      eq(r.chips, [COLORS[6], COLORS[5], COLORS[4], COLORS[1], COLORS[3], COLORS[2]], '새로고침 뒤 최근 목록');
      if (!r.shown) fail('새로고침 뒤 "최근" 줄이 안 보여요');
      // 팔레트에서 지운 색, 바뀐 색은 목록에서 빠짐
      await page.evaluate(c => { const sw = [...document.querySelectorAll('#qbPalette .swatch')].find(s => getComputedStyle(s).backgroundColor === c); sw.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }, hexToRgb(COLORS[6]));
      await sleep(150);
      await clickId(page, 'swatchDelete'); await sleep(200);
      r = await recent(page);
      if (r.chips.includes(COLORS[6]) || r.chips.length !== 5) fail('팔레트에서 지운 색이 최근 목록에 남아 있어요 (' + r.chips.join(', ') + ')');
      await page.evaluate(() => { PRESET_COLORS[PRESET_COLORS.findIndex(c => c === '#FBC02D')] = '#123456'; buildPalette(); });
      r = await recent(page);
      if (r.chips.includes(COLORS[2]) || r.chips.length !== 4) fail('팔레트에서 바뀌어 사라진 색이 최근 목록에 남아 있어요 (' + r.chips.join(', ') + ')');
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  // 2) 저장소를 못 쓰는 브라우저: 그 화면 안에서는 그대로 동작
  {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    try {
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); } catch (e) {}
        const g = Storage.prototype.getItem, s = Storage.prototype.setItem;
        Storage.prototype.getItem = function (k) { if (k === 'crochet-recent-colors') throw new Error('blocked'); return g.call(this, k); };
        Storage.prototype.setItem = function (k, v) { if (k === 'crochet-recent-colors') throw new Error('blocked'); return s.call(this, k, v); };
      });
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + '/pattern/', { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(250);
      await setPalette(page);
      await pick(page, 1, 2, 3);
      const r = await recent(page);
      eq(r.chips, [COLORS[3], COLORS[2], COLORS[1], COLORS[0]], '저장소를 못 쓸 때 최근 목록');
      errors.forEach(e => fail('저장소를 못 쓸 때: ' + e));
    } finally { await ctx.close(); }
  }
  // 3) 영어 페이지
  {
    const t = await openPage('/en/pattern/');
    try {
      const { page } = t;
      await setPalette(page);
      await pick(page, 1, 2);
      const r = await recent(page);
      eq(r.chips, [COLORS[2], COLORS[1], COLORS[0]], '영어 페이지 최근 목록');
      if (r.label !== 'Recent') fail('/en/pattern/: 라벨이 "Recent"가 아니에요 (' + r.label + ')');
      if (r.names.some(n => !/^Recent color #[0-9A-F]{6}$/.test(n || ''))) fail('/en/pattern/: 최근 색 버튼 이름이 영어가 아니에요 (' + r.names.join(', ') + ')');
      t.errors.forEach(e => fail('/en/pattern/: ' + e));
    } finally { await t.close(); }
  }
  // 4) 휴대폰 폭 (어두운 화면). 4단계부터 칠할 색·최근 줄은 새 도구 막대에 있음(#qbRecentRow)
  for (const [p, w] of [['/pattern/', 320], ['/pattern/', 360], ['/en/pattern/', 390]]) {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    try {
      await page.setViewport({ width: w, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => { try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); localStorage.setItem('crochet-ui-theme', 'dark'); } catch (e) {} });
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
      // 팔레트가 아주 길면(색 9개 이상) 휴대폰 320px에서는 팔레트 자체가 넘치므로, 여기서는 색 6개로 "최근" 줄만 확인
      await page.evaluate(cs => { PRESET_COLORS.length = 0; cs.slice(0, 6).forEach(c => PRESET_COLORS.push(c)); activeColor = PRESET_COLORS[0]; buildPalette(); }, COLORS);
      await pick(page, 1, 2, 3, 4);
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth, row = document.getElementById('qbRecentRow'), rr = row.getBoundingClientRect();
        const chips = [...document.querySelectorAll('#qbRecentChips .recent-chip')].map(b => b.getBoundingClientRect());
        return { shown: row.getClientRects().length > 0, rowIn: rr.left >= 0 && rr.right <= vw, chipsIn: chips.every(c => c.left >= 0 && c.right <= vw), minW: Math.min(...chips.map(c => c.width)), n: chips.length, over: document.documentElement.scrollWidth - vw, theme: document.documentElement.getAttribute('data-theme') };
      });
      const label = p + ' ' + w + 'px 어두운 화면';
      if (!m.shown || m.n !== 5) { fail(label + ': 최근 줄이 안 보이거나 색 개수가 달라요 (' + JSON.stringify(m) + ')'); continue; }
      if (m.theme !== 'dark') fail(label + ': 어두운 화면이 적용되지 않았어요');
      if (!m.rowIn || !m.chipsIn) fail(label + ': 최근 줄이 화면 밖으로 넘치거나 잘려요');
      if (m.minW < 20) fail(label + ': 휴대폰에서 최근 색 버튼이 너무 작아요 (' + m.minW + 'px)');
      if (m.over > 1) fail(label + ': 가로로 ' + m.over + 'px 넘쳐요');
      errors.forEach(e => fail(label + ': ' + e));
    } finally { await ctx.close(); }
  }
  note('순서·중복·6개·새로고침·누르면 선택·지우면 빠짐, 저장소 오류, 영어, 휴대폰 3곳');
});

test('버튼 툴팁에 단축키 표시: 한국어·영어·맥(⌘), 접근성 이름은 그대로, 단축키가 실제로 동작, 휴대폰', async (fail, note) => {
  // [버튼 id, 한국어 툴팁, 영어 툴팁, 접근성 이름(있으면, 단축키 없이 그대로) 한국어/영어]
  const TIPS = [
    ['openFileBtn', '도안 파일 열기 (Ctrl+O)', 'Open pattern file (Ctrl+O)'],
    ['saveFileBtn', '도안 파일로 저장 (Ctrl+S)', 'Save pattern file (Ctrl+S)'],
    ['undoBtn', '되돌리기 (Ctrl+Z)', 'Undo (Ctrl+Z)', '되돌리기', 'Undo'],
    ['redoBtn', '다시하기 (Ctrl+Shift+Z / Ctrl+Y)', 'Redo (Ctrl+Shift+Z / Ctrl+Y)', '다시하기', 'Redo'],
    ['copyBtn', '떠 있는 글자·장식·선택 영역 복사 (Ctrl+C)', 'Copy floating item (Ctrl+C)'],
    ['pasteBtn', '붙여넣기 (Ctrl+V)', 'Paste (Ctrl+V)'],
    ['stampCopyBtn', '복사 (Ctrl+C)', 'Copy (Ctrl+C)'],
    ['stampDeleteBtn', '삭제 (Delete)', 'Delete (Del)'],
    ['stampCancelBtn', '취소 (Esc)', 'Cancel (Esc)'],
    ['stampPlaceBtn', '완료 (Enter)', 'Done (Enter)'],
    ['nudgeL', '왼쪽으로 (←)', 'Left (←)', '왼쪽으로', 'Left'],
    ['nudgeU', '위로 (↑)', 'Up (↑)', '위로', 'Up'],
    ['nudgeD', '아래로 (↓)', 'Down (↓)', '아래로', 'Down'],
    ['nudgeR', '오른쪽으로 (→)', 'Right (→)', '오른쪽으로', 'Right'],
    ['knitMinusBtn', '아래 단 (↓)', 'Row below (↓)', '아래 단', 'Row below'],
    ['knitPlusBtn', '위 단 (↑)', 'Row above (↑)', '위 단', 'Row above'],
    ['knitExitBtn', '도안 수정으로 (Esc)', 'Back to editing (Esc)'],
    ['hexCancel', '취소 (Esc)', 'Cancel (Esc)'],
    ['hexOk', '추가 (Enter)', 'Add (Enter)'],
    ['deCancel', '취소 (Esc)', 'Cancel (Esc)'],
    ['askCancel', '취소 (Esc)', 'Cancel (Esc)'],
    ['swatchCancel', '닫기 (Esc)', 'Close (Esc)'],
    // 4단계: 화면에 보이는 새 도구 막대의 같은 버튼도 같은 툴팁·접근성 이름
    ['qbUndo', '되돌리기 (Ctrl+Z)', 'Undo (Ctrl+Z)', '되돌리기', 'Undo'],
    ['qbRedo', '다시하기 (Ctrl+Shift+Z / Ctrl+Y)', 'Redo (Ctrl+Shift+Z / Ctrl+Y)', '다시하기', 'Redo'],
    ['qbOpen', '도안 파일 열기 (Ctrl+O)', 'Open pattern file (Ctrl+O)', '열기', 'Open'],
    // 5a: 예전 접기 단축키 Ctrl+\는 없앴으므로 (숨은) 접기 버튼 툴팁에 단축키가 없어야 함
    ['ribbonFoldBtn', '작업창 접기', 'Collapse toolbar', '작업창 접기', 'Collapse toolbar'],
  ];
  const read = (page, ids) => page.evaluate(ids => ids.map(id => { const e = document.getElementById(id); return e ? { id, title: e.getAttribute('title'), aria: e.getAttribute('aria-label') } : { id, title: null, aria: null }; }), ids);
  const ids = TIPS.map(r => r[0]);
  // 1) 한국어·영어 (윈도우: Ctrl 표기)
  for (const [p, li] of [['/pattern/', 1], ['/en/pattern/', 2]]) {
    const t = await openPage(p);
    try {
      const { page } = t;
      const got = await read(page, ids);
      TIPS.forEach((row, i) => {
        const g = got[i], want = row[li];
        if (g.title !== want) fail(p + ': ' + row[0] + ' 툴팁이 "' + want + '"이어야 하는데 "' + g.title + '"이에요');
        if (row[3] && g.aria !== row[li + 2]) fail(p + ': ' + row[0] + ' 접근성 이름이 단축키 없이 "' + row[li + 2] + '"여야 하는데 "' + g.aria + '"이에요');
      });
      const bad = await page.evaluate(() => [...document.querySelectorAll('[title]')].filter(e => e.title.includes('⌘')).map(e => e.id || e.className));
      if (bad.length) fail(p + ': 맥이 아닌데 ⌘ 표기가 있어요 (' + bad.join(', ') + ')');
      const bs = await page.evaluate(() => [...document.querySelectorAll('[title], #pane-help')].filter(e => /(Ctrl\+|⌘)\\/.test(e.id === 'pane-help' ? e.textContent : e.title)).map(e => e.id || e.className));
      if (bs.length) fail(p + ': 없앤 단축키 Ctrl+\\ 안내가 툴팁이나 도움말에 남아 있어요 (' + bs.join(', ') + ')');
      t.errors.forEach(e => fail(p + ': ' + e));
    } finally { await t.close(); }
  }
  // 2) 맥: Ctrl 대신 ⌘ (navigator 정보로 판단)
  {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    try {
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluateOnNewDocument(() => {
        try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); } catch (e) {}
        Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      });
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + '/pattern/', { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(250);
      const got = Object.fromEntries((await read(page, ids)).map(g => [g.id, g]));
      const want = { undoBtn: '되돌리기 (⌘Z)', redoBtn: '다시하기 (⌘⇧Z / ⌘Y)', saveFileBtn: '도안 파일로 저장 (⌘S)', openFileBtn: '도안 파일 열기 (⌘O)', pasteBtn: '붙여넣기 (⌘V)', ribbonFoldBtn: '작업창 접기', stampCancelBtn: '취소 (Esc)' };
      Object.keys(want).forEach(id => { if (got[id].title !== want[id]) fail('맥: ' + id + ' 툴팁이 "' + want[id] + '"이어야 하는데 "' + got[id].title + '"이에요'); });
      if (got.undoBtn.aria !== '되돌리기') fail('맥: 접근성 이름에 단축키가 섞였어요 (' + got.undoBtn.aria + ')');
      const left = await page.evaluate(() => [...document.querySelectorAll('[title]')].filter(e => /Ctrl\+/.test(e.title)).map(e => e.id || e.className));
      if (left.length) fail('맥인데 Ctrl 표기가 남아 있어요 (' + left.join(', ') + ')');
      errors.forEach(e => fail('맥: ' + e));
    } finally { await ctx.close(); }
  }
  // 3) 단축키가 실제로 동작 (툴팁에 적은 것만): Ctrl+Z, Ctrl+Y
  {
    const t = await openPage('/pattern/');
    try {
      const { page } = t;
      await pickColor(page, RED);
      await clickCell(page, 0, 0);
      if (!(await page.evaluate(() => !!gridData[0]))) fail('칠하기가 안 돼서 단축키를 확인하지 못했어요');
      await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(150);
      if (await page.evaluate(() => !!gridData[0])) fail('툴팁에 적힌 Ctrl+Z가 되돌리기로 동작하지 않아요');
      await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control'); await sleep(150);
      if (!(await page.evaluate(() => !!gridData[0]))) fail('툴팁에 적힌 Ctrl+Y가 다시하기로 동작하지 않아요');
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  // 4) 휴대폰 폭: 툴팁 추가가 화면에 영향 없음 (한국어·영어)
  for (const [p, w] of [['/pattern/', 360], ['/en/pattern/', 390]]) {
    const t = await openPage(p, { width: w, height: 740, mobile: true });
    try {
      const { page } = t;
      const got = await read(page, ['undoBtn', 'saveFileBtn']);
      if (got[0].title !== (p.startsWith('/en/') ? 'Undo (Ctrl+Z)' : '되돌리기 (Ctrl+Z)')) fail(p + ' ' + w + 'px: 되돌리기 툴팁이 달라요 (' + got[0].title + ')');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 1) fail(p + ' ' + w + 'px: 가로로 ' + over + 'px 넘쳐요');
      t.errors.forEach(e => fail(p + ' ' + w + 'px: ' + e));
    } finally { await t.close(); }
  }
  note('툴팁 ' + TIPS.length + '개 × 한·영, 맥 ⌘, 접근성 이름, Ctrl+Z/Y, 휴대폰 2곳');
});

test('폰트 목록 한글/영문 표시와 영문 전용 폰트 안내: coverage.json과 일치, 이름·값·순서 그대로, 영어, 휴대폰', async (fail, note) => {
  // 폰트 파일 정보(coverage.json)에서 폰트마다 한글 글자(가~힣)가 몇 개 들어 있는지 셈
  const cov = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'fonts', 'coverage.json'), 'utf8'));
  const syllables = fam => {
    const a = String(cov[fam]).split(',').map(Number); let end = 0, n = 0;
    for (let i = 0; i + 1 < a.length; i += 2) { const s = end + a[i]; end = s + a[i + 1]; n += Math.max(0, Math.min(end, 0xD7A4) - Math.max(s, 0xAC00)); }
    return n;
  };
  // HTML 파일에 적힌 원래 옵션 (값, 이름, 순서)
  const htmlOpts = file => [...fs.readFileSync(path.join(ROOT, file), 'utf8').match(/<select class="font-select" id="fontSelect"[\s\S]*?<\/select>/)[0].matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(m => ({ value: m[1], text: m[2].trim() }));
  const koSrc = htmlOpts('pattern/index.html');
  for (const [p, file, korean, latin] of [['/pattern/', 'pattern/index.html', '한글', '영문'], ['/en/pattern/', 'en/pattern/index.html', 'Korean', 'Latin only']]) {
    const t = await openPage(p);
    try {
      const { page } = t;
      const opts = await page.evaluate(() => [...document.querySelectorAll('#fontSelect option')].map(o => ({ value: o.value, text: o.textContent.trim(), label: o.label })));
      const src = htmlOpts(file);
      if (opts.length !== src.length || opts.length < 25) fail(p + ': 폰트 개수가 이상해요 (' + opts.length + ' / ' + src.length + ')');
      opts.forEach((o, i) => {
        const fam = o.value.split('|')[0];
        if (!src[i] || o.value !== src[i].value) fail(p + ': ' + (i + 1) + '번째 폰트 값·순서가 바뀌었어요 (' + o.value + ')');
        if (p === '/pattern/' && src[i] && o.text !== src[i].text) fail(p + ': 폰트 이름이 바뀌었어요 (' + o.text + ')');
        const isLatin = syllables(fam) === 0;
        const flagged = /영문 전용|Latin only/.test(o.text);
        const wantTag = ' · ' + (isLatin ? latin : korean);
        if (isLatin && !(flagged || o.label.endsWith(wantTag))) fail(p + ': 영문 전용 폰트인데 표시가 없어요 (' + fam + ': ' + o.label + ')');
        if (!isLatin && (flagged || !o.label.endsWith(wantTag))) fail(p + ': 한글 지원 폰트인데 "' + wantTag.trim() + '" 표시가 없어요 (' + fam + ': ' + o.label + ')');
        if (!isLatin && /영문 전용|Latin only/.test(o.label)) fail(p + ': 한글을 지원하는 폰트가 영문 전용으로 표시됐어요 (' + o.label + ')');
      });
      if (!opts.some(o => /영문 전용|Latin only/.test(o.label) || o.label.endsWith(' · ' + latin)) || !opts.some(o => o.label.endsWith(' · ' + korean))) fail(p + ': 한글/영문 표시가 둘 다 나오지 않아요');
      // 영문 전용 폰트 + 한글 문구 → 짧은 안내. 영문만 쓰거나 한글 지원 폰트면 안내 없음
      const NOTE = p === '/pattern/' ? '이 폰트는 영문만 지원해서 한글은 다른 글꼴로 나와요.' : 'This font only supports Latin letters, so Korean text is drawn in another font.';
      await page.click('.insp-tab[data-pane="text"]'); await sleep(150);
      const note1 = async (font, text) => {
        await page.select('#fontSelect', font);
        await page.click('#textInput', { clickCount: 3 });
        await page.evaluate(() => { document.getElementById('textInput').value = ''; });
        if (text) await page.type('#textInput', text);
        await sleep(450);
        return page.evaluate(() => { const e = document.getElementById('glyphNote'); return { shown: e.style.display !== 'none' && e.getClientRects().length > 0, text: e.textContent }; });
      };
      let g = await note1('LeckerliOne|v', '뜨개');
      if (!g.shown || g.text !== NOTE) fail(p + ': 영문 전용 폰트로 한글을 쓰면 짧은 안내가 나와야 해요 (' + g.shown + ', ' + g.text + ')');
      g = await note1('LeckerliOne|v', 'Hello');
      if (g.shown && g.text === NOTE) fail(p + ': 영문만 썼는데 한글 안내가 나와요');
      g = await note1('DungGeunMo|16', '뜨개');
      if (g.shown && g.text === NOTE) fail(p + ': 한글 지원 폰트인데 영문 전용 안내가 나와요');
      g = await note1('DepartureMono|11', 'ㄱㅏ');
      if (!g.shown || g.text !== NOTE) fail(p + ': 자음·모음만 써도 영문 전용 폰트에서는 안내가 나와야 해요 (' + g.text + ')');
      // 저장된 폰트 값은 표시 글자가 아니라 원래 값 그대로
      await page.select('#fontSelect', 'PirataOne|v'); await settle();
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('crochet-tool-v1') || '{}').font);
      if (saved !== 'PirataOne|v') fail(p + ': 저장된 폰트 값이 원래 값이 아니에요 (' + saved + ')');
      t.errors.forEach(e => fail(p + ': ' + e));
    } finally { await t.close(); }
  }
  // 휴대폰 360px 어두운 화면: 글자 탭의 폰트 줄과 안내가 넘치거나 잘리지 않음
  for (const [p, w] of [['/pattern/', 360], ['/en/pattern/', 390]]) {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    try {
      await page.setViewport({ width: w, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => { try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); localStorage.setItem('crochet-ui-theme', 'dark'); } catch (e) {} });
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
      await page.click('.insp-tab[data-pane="text"]'); await sleep(200);
      await page.select('#fontSelect', 'DancingScript|v');
      // 글자를 입력하면 뜨는 미리보기 글자 막대(영어 390px에서 원래 50px 넘침, 이번 작업과 상관없음)를 피해, 입력칸 값만 넣고 안내를 직접 갱신
      await page.evaluate(() => { document.getElementById('textInput').value = '뜨개'; return updateGlyphNote(); }); await sleep(500);
      await page.evaluate(() => { if (stamp) cancelStamp(); }); await sleep(200);
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth, s = document.getElementById('fontSelect').getBoundingClientRect(), n = document.getElementById('glyphNote'), nr = n.getBoundingClientRect();
        return { selIn: s.left >= 0 && s.right <= vw, noteShown: n.getClientRects().length > 0, noteIn: nr.left >= 0 && nr.right <= vw, clipped: n.scrollWidth > n.clientWidth + 1, over: document.documentElement.scrollWidth - vw, theme: document.documentElement.getAttribute('data-theme') };
      });
      const label = p + ' ' + w + 'px 어두운 화면';
      if (!m.noteShown) fail(label + ': 영문 전용 폰트 안내가 안 보여요');
      if (m.theme !== 'dark') fail(label + ': 어두운 화면이 적용되지 않았어요');
      if (!m.selIn || !m.noteIn || m.clipped) fail(label + ': 폰트 선택이나 안내가 화면 밖으로 넘치거나 잘려요 (' + JSON.stringify(m) + ')');
      if (m.over > 1) fail(label + ': 가로로 ' + m.over + 'px 넘쳐요');
      errors.forEach(e => fail(label + ': ' + e));
    } finally { await ctx.close(); }
  }
  note('폰트 ' + koSrc.length + '개 × 한·영 표시, coverage.json과 일치, 안내 4가지, 저장 값, 휴대폰 2곳');
});

test('좁은 화면 넘침: 색이 많은 팔레트(9·12·20·50개), 320·360·390px 라이트·다크, 배경색 팔레트, PC는 기존 모양 그대로', async (fail, note) => {
  const BASE30 = ['#222222', '#D32F2F', '#FBC02D', '#1976D2', '#388E3C', '#8E24AA', '#00ACC1', '#F57C00', '#6D4C41', '#E91E63', '#009688', '#3F51B5', '#795548', '#607D8B', '#CDDC39', '#FF5722', '#9C27B0', '#03A9F4', '#8BC34A', '#FFC107', '#B71C1C', '#1B5E20', '#0D47A1', '#4A148C', '#BF360C', '#33691E', '#006064', '#311B92', '#880E4F', '#827717'];
  const ALL = BASE30.concat(Array.from({ length: 20 }, (_, i) => '#' + ((i * 5130427 + 1118481) & 0xFFFFFF).toString(16).padStart(6, '0')));
  const openMobile = async (p, w, dark) => {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    await page.setViewport({ width: w, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
    await page.evaluateOnNewDocument(d => { try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); if (d) localStorage.setItem('crochet-ui-theme', 'dark'); } catch (e) {} }, dark);
    await page.evaluateOnNewDocument(SKIP_START);
    await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
    return { ctx, page, errors };
  };
  const over = page => page.evaluate(() => { const vw = document.documentElement.clientWidth; return { over: document.documentElement.scrollWidth - vw, bad: [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > vw + 1).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right - vw)).slice(0, 4) }; });
  // 1) 칠할 색 팔레트: 색 5·9·12·20·30개 (4단계부터 화면의 칠할 색은 새 도구 막대 #qbPalette·#qbRecentRow)
  for (const dark of [false, true]) for (const w of [320, 360, 390]) {
    const { ctx, page, errors } = await openMobile('/pattern/', w, dark);
    try {
      const label = '/pattern/ ' + w + 'px ' + (dark ? '어두운 화면' : '밝은 화면');
      for (const n of [5, 9, 12, 20, 50]) {
        await page.evaluate((cs, n) => {
          PRESET_COLORS.length = 0; cs.slice(0, n).forEach(c => PRESET_COLORS.push(c)); activeColor = PRESET_COLORS[0]; buildPalette();
          [1, 2, 3].forEach(i => pickPaintColor(PRESET_COLORS[i % PRESET_COLORS.length]));
        }, ALL, n);
        await sleep(350);
        const o = await over(page);
        const m = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth, pal = document.getElementById('qbPalette'), pr = pal.getBoundingClientRect();
          const grp = document.getElementById('qbColors');
          const last = [...pal.querySelectorAll('.swatch, .add-color')].pop().getBoundingClientRect();
          const sel = pal.querySelector('.swatch.selected');
          const rr = document.getElementById('qbRecentRow'), ch = [...document.querySelectorAll('#qbRecentChips .recent-chip')];
          // 묶음 높이 = 첫 색 칸 위 ~ 최근 줄(없으면 마지막 칸) 아래 (막대 안쪽 여백은 빼고 셈)
          const top0 = pal.querySelector('.swatch').getBoundingClientRect().top, body = { height: (rr.hidden ? last.bottom : rr.getBoundingClientRect().bottom) - top0 };
          return { palIn: pr.left >= 0 && pr.right <= vw + 0.5, palH: Math.round(pr.height), scrollable: pal.scrollHeight > pal.clientHeight + 1, wrap: grp.classList.contains('pal-wrap'), bodyH: Math.round(body.height),
            addReach: pal.scrollWidth <= pal.clientWidth + 1, sel: !!sel, recent: !rr.hidden && ch.length >= 2, recentSel: ch.some(c => c.classList.contains('selected')), flexWrap: getComputedStyle(pal).flexWrap };
        });
        if (o.over > 1) fail(label + ': 색 ' + n + '개일 때 가로로 ' + o.over + 'px 넘쳐요 (' + o.bad.join(', ') + ')');
        if (!m.palIn) fail(label + ': 색 ' + n + '개일 때 팔레트가 화면 밖으로 나가요');
        if (!m.addReach) fail(label + ': 색 ' + n + '개일 때 팔레트가 옆으로 스크롤돼야 하는 모양이에요 (줄바꿈이 안 됨)');
        if (m.palH > 104) fail(label + ': 색 ' + n + '개일 때 팔레트 높이가 너무 커요 (' + m.palH + 'px, 최대 약 102px)');
        if (n === 50 && !m.scrollable) fail(label + ': 색 50개인데 최대 높이 안에서 세로로 스크롤되지 않아요');
        // 한 줄 + 최근 색 줄(터치 22px): 팔레트 28 + 간격 6 + 22 = 56px까지 (최근 줄이 없으면 44px 그대로)
        if (n === 5 && (m.wrap || m.bodyH > 56)) fail(label + ': 색 5개(한 줄)인데 묶음 높이가 늘어났어요 (pal-wrap ' + m.wrap + ', ' + m.bodyH + 'px)');
        if (!m.sel) fail(label + ': 색 ' + n + '개일 때 선택 표시가 없어요');
        if (!m.recent || !m.recentSel) fail(label + ': 색 ' + n + '개일 때 최근 색 줄이나 선택 표시가 사라졌어요');
      }
      // 색 추가(+) 버튼이 눈에 보이고 눌림
      await page.evaluate((cs) => { PRESET_COLORS.length = 0; cs.slice(0, 12).forEach(c => PRESET_COLORS.push(c)); buildPalette(); }, ALL);
      await sleep(250);
      const add = await page.evaluate(() => { const b = document.querySelector('#qbPalette .add-color').getBoundingClientRect(), vw = document.documentElement.clientWidth; return { in: b.left >= 0 && b.right <= vw && b.width >= 24 }; });
      if (!add.in) fail(label + ': 색 12개일 때 색 추가(+) 버튼이 화면 안에 보이지 않아요');
      await page.evaluate(() => document.querySelector('#qbPalette .add-color').click()); await sleep(250);
      if (!(await page.evaluate(() => document.getElementById('hexModal').classList.contains('show')))) fail(label + ': 색 추가(+) 버튼을 눌러도 색 추가 창이 안 열려요');
      // 배경색 팔레트(격자 탭): 색 30개여도 안 넘침
      await page.evaluate(() => { document.getElementById('hexCancel').click(); });
      await page.click('.insp-tab[data-pane="grid"]').catch(() => {}); await sleep(200);
      const o2 = await over(page);
      if (o2.over > 1) fail(label + ': 배경색 팔레트 때문에 가로로 ' + o2.over + 'px 넘쳐요 (' + o2.bad.join(', ') + ')');
      errors.forEach(e => fail(label + ': ' + e));
    } finally { await ctx.close(); }
  }
  // PC 폭은 기존 모양 그대로: 한 줄(줄바꿈 없음), 묶음 높이 늘리는 표시 없음
  {
    const t = await openPage('/pattern/');
    try {
      await t.page.evaluate(cs => { PRESET_COLORS.length = 0; cs.slice(0, 12).forEach(c => PRESET_COLORS.push(c)); buildPalette(); }, ALL);
      await sleep(250);
      const r = await t.page.evaluate(() => { const sw = [...document.querySelectorAll('#qbPalette .swatch, #qbPalette .add-color')].map(e => e.getBoundingClientRect()); return { flexWrap: getComputedStyle(document.getElementById('qbPalette')).flexWrap, wrap: document.getElementById('qbColors').classList.contains('pal-wrap'), h: Math.round(Math.max(...sw.map(b => b.bottom)) - Math.min(...sw.map(b => b.top))) }; });
      if (r.flexWrap !== 'nowrap' || r.wrap || r.h > 32) fail('PC(1440px)의 팔레트 모양이 바뀌었어요 (' + JSON.stringify(r) + ')');
      t.errors.forEach(e => fail(e));
    } finally { await t.close(); }
  }
  note('팔레트 색 5·9·12·20·50개 × 320·360·390px × 라이트·다크, 배경색 팔레트, 색 추가(+), 최근 색 줄, PC 그대로');
});

test('미리보기 글자 막대: 영어·한국어, 320·360·390px 라이트·다크에서 넘침 없음, 버튼은 모두 화면 안에 보이고 누르기 쉬운 크기', async (fail, note) => {
  const openMobile = async (p, w, dark) => {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    await page.setViewport({ width: w, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
    await page.evaluateOnNewDocument(d => { try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); if (d) localStorage.setItem('crochet-ui-theme', 'dark'); } catch (e) {} }, dark);
    await page.evaluateOnNewDocument(SKIP_START);
    await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
    return { ctx, page, errors };
  };
  const over = page => page.evaluate(() => { const vw = document.documentElement.clientWidth; return { over: document.documentElement.scrollWidth - vw, bad: [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > vw + 1).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right - vw)).slice(0, 4) }; });
  for (const dark of [false, true]) for (const w of [320, 360, 390]) for (const p of ['/en/pattern/', '/pattern/']) {
    const { ctx, page, errors } = await openMobile(p, w, dark);
    try {
      const label = p + ' ' + w + 'px ' + (dark ? '어두운 화면' : '밝은 화면') + ' 글자 막대';
      await page.click('.insp-tab[data-pane="text"]'); await sleep(150);
      await page.click('#textInput', { clickCount: 3 });
      await page.type('#textInput', p.startsWith('/en/') ? 'Hello' : '뜨개');
      if (!await waitFor(page, () => !!stamp, 8000)) { fail(label + ': 글자를 입력해도 미리보기 글자 막대가 안 떠요'); continue; }
      await sleep(400);
      const o = await over(page);
      const b = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        return [...document.querySelectorAll('#stampBar button')].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { id: e.id, in: r.left >= -0.5 && r.right <= vw + 0.5, w: Math.round(r.width), h: Math.round(r.height), act: e.matches('.btn-stamp-cancel, .btn-stamp-place, .nudge button') }; });
      });
      if (o.over > 1) fail(label + ': 가로로 ' + o.over + 'px 넘쳐요 (' + o.bad.join(', ') + ')');
      const out = b.filter(x => !x.in).map(x => x.id);
      if (out.length) fail(label + ': 막대의 버튼이 화면 밖으로 나가요 (' + out.join(', ') + ')');
      const small = b.filter(x => x.act && (x.h < 40 || x.w < 40)).map(x => x.id + ' ' + x.w + 'x' + x.h);
      if (small.length) fail(label + ': 막대의 버튼이 누르기에 너무 작아요 (' + small.join(', ') + ')');
      if (!b.some(x => x.id === 'stampPlaceBtn') || !b.some(x => x.id === 'stampCancelBtn')) fail(label + ': 완료·취소 버튼이 안 보여요');
      errors.forEach(e => fail(label + ': ' + e));
    } finally { await ctx.close(); }
  }
  note('글자 막대 한·영 × 320·360·390px × 라이트·다크');
});

test('소개 페이지 가로 넘침: 홈·영어 홈·예시·가이드·소개·개인정보·폰트 출처·코수 세기, 320·360·390·768·1440px 라이트·다크', async (fail, note) => {
  const PAGES = ['/', '/en/', '/examples/', '/guides/', '/guides/reading-charts/', '/guides/lettering-size/', '/guides/knitting-direction/', '/guides/patchwork-practice/', '/about/', '/privacy/', '/credits/', '/counter/'];
  const WIDTHS = [320, 360, 390, 768, 1440];
  const openSite = async (p, w, scheme, mobile, extra) => {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    await page.setViewport({ width: w, height: 900, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }].concat(extra || []));
    await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(150);
    return { ctx, page, errors };
  };
  // 1) 모든 페이지 × 5가지 폭 × 라이트·다크: 가로 넘침 없음
  for (const scheme of ['light', 'dark']) for (const p of PAGES) {
    const { ctx, page, errors } = await openSite(p, 1440, scheme, false);
    try {
      for (const w of WIDTHS) {
        await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 }); await sleep(80);
        const r = await page.evaluate(() => { const vw = document.documentElement.clientWidth; return { over: document.documentElement.scrollWidth - vw, bad: [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > vw + 1).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right - vw)).slice(0, 3) }; });
        if (r.over > 1) fail(p + ' ' + w + 'px ' + (scheme === 'dark' ? '어두운' : '밝은') + ' 화면: 가로로 ' + r.over + 'px 넘쳐요 (' + r.bad.join(', ') + ')');
      }
      errors.forEach(e => fail(p + ': ' + e));
    } finally { await ctx.close(); }
  }
  note('소개 페이지 ' + PAGES.length + '개 × 5가지 폭 × 라이트·다크 넘침 없음');
});

test('소개 페이지 디자인 값: 제목이 낱말 중간에서 안 끊김, 타이포·여백·카드·버튼 값, 호버는 마우스에서만(터치·움직임 줄이기에서는 없음)', async (fail, note) => {
  const PAGES = ['/', '/en/', '/examples/', '/guides/', '/guides/reading-charts/', '/guides/lettering-size/', '/guides/knitting-direction/', '/guides/patchwork-practice/', '/about/', '/privacy/', '/credits/', '/counter/'];
  const WIDTHS = [320, 360, 390, 768, 1440];
  const openSite = async (p, w, scheme, mobile, extra) => {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    await page.setViewport({ width: w, height: 900, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }].concat(extra || []));
    await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(150);
    return { ctx, page, errors };
  };
  // 2) 홈(한·영): 제목이 낱말 중간에서 안 끊김 + 값 확인
  for (const p of ['/', '/en/']) {
    const { ctx, page } = await openSite(p, 1440, 'light', false);
    try {
      for (const w of WIDTHS) {
        await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 }); await sleep(100);
        const r = await page.evaluate(() => {
          const out = [];
          const breaks = el => { // 줄이 바뀌는 자리가 낱말 중간이면 목록에 넣음
            const bad = []; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let prevTop = null, prevCh = null;
            while (walker.nextNode()) { const n = walker.currentNode; for (let i = 0; i < n.nodeValue.length; i++) { const ch = n.nodeValue[i]; if (/\s/.test(ch)) { prevCh = ch; continue; } const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1); const t = Math.round(rg.getBoundingClientRect().top); if (prevTop !== null && t > prevTop + 5 && prevCh && !/\s/.test(prevCh)) bad.push(n.nodeValue.slice(Math.max(0, i - 3), i + 3)); prevTop = t; prevCh = ch; } }
            return bad;
          };
          document.querySelectorAll('h1, h2').forEach(h => { const b = breaks(h); if (b.length) out.push(h.tagName + ':' + h.textContent.trim().slice(0, 20) + ' → ' + b.join('|')); });
          return out;
        });
        if (r.length) fail(p + ' ' + w + 'px: 제목이 낱말 중간에서 끊겨요 (' + r.join(', ') + ')');
      }
    } finally { await ctx.close(); }
  }
  // 3) 값 확인 (PC 1440px, 휴대폰 390px)
  for (const [w, mobile] of [[1440, false], [390, true]]) {
    const { ctx, page } = await openSite('/', w, 'light', mobile);
    try {
      const v = await page.evaluate(() => {
        const cs = (sel) => getComputedStyle(document.querySelector(sel)), px = x => parseFloat(x);
        const wrap = document.querySelector('.wrap'), secs = [...document.querySelectorAll('main > .home-sec')], hero = cs('.hero'), h1 = cs('.hero h1'), lead = cs('.hero .lead'), h2 = cs('main h2'), card = cs('.card'), btn = cs('.btn');
        const sp = secs.map(e => getComputedStyle(e)); const gaps = sp.slice(1).map((c, i) => px(sp[i].paddingBottom) + px(c.paddingTop));
        const pads = [...document.querySelectorAll('.strength-card, .tool-card')].map(e => px(getComputedStyle(e).paddingLeft));
        return { gaps, pads, mainTop: secs.length ? px(sp[0].paddingTop) : -1, mainBottom: secs.length ? px(sp[sp.length - 1].paddingBottom) : -1, wrapMax: cs('.wrap').maxWidth, cols: hero.gridTemplateColumns.split(' ').length, gap: px(hero.columnGap), h1Size: px(h1.fontSize), h1Lh: px(h1.lineHeight) / px(h1.fontSize), h1LS: px(h1.letterSpacing) / px(h1.fontSize), h1Weight: parseInt(h1.fontWeight, 10), h1Break: h1.wordBreak,
          leadSize: px(lead.fontSize), leadLh: px(lead.lineHeight) / px(lead.fontSize), leadMax: px(lead.maxWidth), h2Size: px(h2.fontSize), h2Break: h2.wordBreak, h2LS: px(h2.letterSpacing) / px(h2.fontSize), radius: px(card.borderTopLeftRadius),
          btnH: document.querySelector('.btn').getBoundingClientRect().height, btnPad: px(btn.paddingLeft), btnR: px(btn.borderTopLeftRadius), btnW: parseInt(btn.fontWeight, 10), wrapW: Math.round(wrap.getBoundingClientRect().width) };
      });
      const L = w + 'px: ';
      if (w === 1440) {
        if (v.wrapMax !== '1120px' || v.wrapW > 1120) fail(L + '컨테이너 최대 폭이 1120px이 아니에요 (' + v.wrapMax + ', ' + v.wrapW + ')');
        if (v.mainTop !== 72 || v.mainBottom !== 112) fail(L + '홈 본문 위아래 여백이 72/112px이 아니에요 (' + v.mainTop + '/' + v.mainBottom + ')');
        if (!v.gaps.length || v.gaps.some(g => g < 80 || g > 96)) fail(L + '홈 구역 사이 간격이 80~96px이 아니에요 (' + v.gaps.join(', ') + ')');
        if (!v.pads.length || v.pads.some(p => p < 28 || p > 32)) fail(L + '강점·도구 카드 안쪽 여백이 28~32px이 아니에요 (' + v.pads.join(', ') + ')');
        if (v.cols !== 2 || v.gap < 64 || v.gap > 80) fail(L + '히어로가 2열에 열 간격 64~80px이어야 해요 (' + v.cols + '열, ' + v.gap + 'px)');
        if (Math.round(v.h1Size) !== 64) fail(L + '히어로 제목 크기가 64px이 아니에요 (' + v.h1Size + ')');
        if (Math.round(v.h2Size) !== 40) fail(L + '섹션 제목 크기가 40px이 아니에요 (' + v.h2Size + ')');
      } else {
        if (v.mainTop !== 36 || v.mainBottom !== 56) fail(L + '휴대폰 홈 본문 위아래 여백이 36/56px(절반)이 아니에요 (' + v.mainTop + '/' + v.mainBottom + ')');
        if (!v.gaps.length || v.gaps.some(g => g !== 56)) fail(L + '휴대폰 홈 구역 사이 간격이 56px이 아니에요 (' + v.gaps.join(', ') + ')');
        if (v.cols !== 1) fail(L + '휴대폰에서 히어로가 1열이어야 해요 (' + v.cols + '열)');
        if (Math.round(v.h1Size) !== 40) fail(L + '히어로 제목 최소 크기가 40px이 아니에요 (' + v.h1Size + ')');
        if (Math.round(v.h2Size) !== 28) fail(L + '섹션 제목 최소 크기가 28px이 아니에요 (' + v.h2Size + ')');
      }
      if (Math.abs(v.h1Lh - 1.15) > 0.01 || Math.abs(v.h1LS + 0.02) > 0.003 || v.h1Weight < 600 || v.h1Weight > 700 || v.h1Break !== 'keep-all') fail(L + '히어로 제목 줄간격·자간·굵기·줄바꿈이 맞지 않아요 (' + JSON.stringify([v.h1Lh, v.h1LS, v.h1Weight, v.h1Break]) + ')');
      if (v.leadSize !== 18 || Math.abs(v.leadLh - 1.75) > 0.01 || v.leadMax !== 500) fail(L + '히어로 설명 글(18px, 줄간격 1.75, 최대 폭 500px)이 맞지 않아요 (' + JSON.stringify([v.leadSize, v.leadLh, v.leadMax]) + ')');
      if (v.h2Break !== 'keep-all' || Math.abs(v.h2LS + 0.02) > 0.003) fail(L + '섹션 제목 자간·줄바꿈이 맞지 않아요');
      if (v.radius < 18 || v.radius > 20) fail(L + '카드 모서리가 18~20px이 아니에요 (' + v.radius + ')');
      if (v.btnH < 48 || v.btnH > 50 || v.btnPad !== 24 || v.btnR !== 14 || v.btnW !== 600) fail(L + '버튼(높이 48~50, 좌우 24, 둥글기 14, 굵기 600)이 맞지 않아요 (' + JSON.stringify([v.btnH, v.btnPad, v.btnR, v.btnW]) + ')');
    } finally { await ctx.close(); }
  }
  // 4) 호버: 마우스(PC)에서만 떠오름, 터치에서는 효과 없음, 움직임 줄이기에서는 색만 바뀜
  const hoverInfo = async (page, sel) => {
    const before = await page.evaluate(sel => { const e = document.querySelector(sel), c = getComputedStyle(e); return { b: c.borderTopColor, sh: c.boxShadow }; }, sel);
    await page.hover(sel); await sleep(450);
    const after = await page.evaluate(sel => { const e = document.querySelector(sel), c = getComputedStyle(e); const m = c.transform === 'none' ? 0 : parseFloat(c.transform.replace(/matrix\(|\)/g, '').split(',')[5]); return { ty: m, b: c.borderTopColor, sh: c.boxShadow }; }, sel);
    return { before, after };
  };
  {
    const { ctx, page } = await openSite('/', 1440, 'light', false);
    try {
      await page.evaluate(() => document.querySelector('.tool-card').scrollIntoView({ block: 'center' }));
      const c = await hoverInfo(page, '.tool-card');
      if (Math.abs(c.after.ty + 3) > 0.2) fail('PC: 도구 카드에 마우스를 올려도 3px 떠오르지 않아요 (' + c.after.ty + ')');
      if (c.after.sh === c.before.sh || c.after.b === c.before.b) fail('PC: 카드 호버에 그림자·테두리색 변화가 없어요');
      await page.mouse.move(5, 5); await sleep(300);
      const b = await hoverInfo(page, '.hero .btn');
      if (Math.abs(b.after.ty + 1) > 0.2) fail('PC: 버튼에 마우스를 올려도 1px 떠오르지 않아요 (' + b.after.ty + ')');
    } finally { await ctx.close(); }
  }
  {
    const { ctx, page } = await openSite('/', 390, 'light', true);
    try {
      await page.evaluate(() => document.querySelector('.tool-card').scrollIntoView({ block: 'center' }));
      const c = await hoverInfo(page, '.tool-card');
      if (c.after.ty !== 0) fail('휴대폰(터치): 카드에 호버 움직임이 생겨요 (' + c.after.ty + ')');
      if (await page.evaluate(() => matchMedia('(hover: hover)').matches)) fail('휴대폰 모의 환경인데 호버가 가능한 장치로 인식돼요');
    } finally { await ctx.close(); }
  }
  {
    const { ctx, page } = await openSite('/', 1440, 'light', false, [{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    try {
      await page.evaluate(() => document.querySelector('.tool-card').scrollIntoView({ block: 'center' }));
      const c = await hoverInfo(page, '.tool-card');
      if (c.after.ty !== 0) fail('움직임 줄이기: 카드가 움직여요 (' + c.after.ty + ')');
      if (c.after.b === c.before.b) fail('움직임 줄이기: 카드 호버에서 테두리 색은 바뀌어야 해요');
      const b = await hoverInfo(page, '.hero .btn');
      if (b.after.ty !== 0) fail('움직임 줄이기: 버튼이 움직여요 (' + b.after.ty + ')');
    } finally { await ctx.close(); }
  }
  note('제목 어절, 타이포·여백·카드·버튼 값, 호버 3가지 환경');
});

test('홈 새 구조: 구역 순서(히어로→예시 갤러리→강점 카드→도구→가이드→질문), eyebrow, 시연 그림, 한·영 같은 구조, 배경 번갈아, 이미지 alt·lazy, 휴대폰 1열·그림 비율', async (fail, note) => {
  const ORDER = ['hero-sec', 'gallery-sec', 'strengths-sec', 'tools-sec', 'guides-sec', 'faq-sec'];
  const shapes = {};
  for (const [p, eyebrow] of [['/', '방안뜨기(filet) 도안 지원'], ['/en/', 'Filet charts included']]) {
    for (const [w, mobile] of [[1440, false], [390, true], [320, true]]) for (const scheme of ['light', 'dark']) {
      const ctx = await BROWSER.createBrowserContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
      try {
        await page.setViewport({ width: w, height: 900, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
        await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 });
        // 아래쪽(lazy) 그림을 하나씩 화면에 보여 줘서 다 불러온 뒤에 확인
        await page.evaluate(async () => { for (const i of document.querySelectorAll('main img[loading="lazy"]')) { i.scrollIntoView({ block: 'center' }); await Promise.race([i.decode().catch(() => {}), new Promise(r => setTimeout(r, 3000))]); } window.scrollTo(0, 0); });
        await sleep(300);
        const L = p + ' ' + w + 'px ' + (scheme === 'dark' ? '어두운' : '밝은') + ' 화면: ';
        const r = await page.evaluate(ORDER => {
          const secs = [...document.querySelectorAll('main > section.home-sec')];
          const kinds = secs.map(s => ORDER.find(k => s.classList.contains(k)) || s.className);
          const bg = secs.map(s => getComputedStyle(s).backgroundColor);
          const hero = document.querySelector('.hero-sec');
          const eb = hero && hero.querySelector('.eyebrow'), h1 = hero && hero.querySelector('h1');
          const ebCs = eb && getComputedStyle(eb);
          const heroImgs = hero ? [...hero.querySelectorAll('img')] : [];
          const imgs = [...document.querySelectorAll('main img')];
          const vw = document.documentElement.clientWidth;
          const gal = document.querySelector('.gallery-sec');
          const galCards = gal ? [...gal.querySelectorAll('.ex-card')] : [];
          const thumbs = galCards.map(c => { const i = c.querySelector('.thumb img'), t = c.querySelector('.thumb').getBoundingClientRect(), ir = i.getBoundingClientRect(); return { natural: i.naturalWidth / i.naturalHeight, shown: ir.width / ir.height, fillW: Math.min(ir.width, t.width) / t.width, loaded: i.complete && i.naturalWidth > 0, contain: getComputedStyle(i).objectFit }; });
          const tops = sel => [...document.querySelectorAll(sel)].map(e => Math.round(e.getBoundingClientRect().left));
          const heroArt = document.querySelector('.hero-art'), haCs = heroArt && getComputedStyle(heroArt);
          // 구조 모양(한·영 비교용): 구역 종류와 그 안의 카드·목록 개수
          const shape = kinds.join('>') + '|ex' + galCards.length + '|st' + document.querySelectorAll('.strength-card').length + '|fl' + document.querySelectorAll('.feature-lines li').length + '|tc' + document.querySelectorAll('.tool-cards .tool-card').length + '|gd' + document.querySelectorAll('.guide-item').length + '|faq' + document.querySelectorAll('.faq details').length + '|more' + document.querySelectorAll('.gallery-sec .sec-more').length + '|stimg' + [...document.querySelectorAll('.strength-card')].map(c => c.querySelectorAll('.strength-img img').length).join('');
          const sImgs = [...document.querySelectorAll('.strength-card .strength-img img')].map(i => { const b = i.getBoundingClientRect(), box = i.closest('.strength-img'), bc = getComputedStyle(box); return { src: i.getAttribute('src'), file: i.src.split('/').pop(), ok: i.complete && i.naturalWidth > 0, alt: (i.getAttribute('alt') || '').trim(), lazy: i.getAttribute('loading'), ratio: Math.abs(b.width / b.height - i.naturalWidth / i.naturalHeight), inCard: i.closest('.strength-card').querySelector('h3').textContent.trim(), radius: parseFloat(bc.borderTopLeftRadius), border: bc.borderTopStyle !== 'none' && parseFloat(bc.borderTopWidth) > 0, natW: i.naturalWidth, shownW: b.width, shownH: b.height, boxTop: Math.round(box.getBoundingClientRect().top), boxH: Math.round(box.getBoundingClientRect().height), inBox: b.left >= box.getBoundingClientRect().left - 1 && b.right <= box.getBoundingClientRect().right + 1 && b.top >= box.getBoundingClientRect().top - 1 && b.bottom <= box.getBoundingClientRect().bottom + 1, boxRight: box.getBoundingClientRect().right, cardRight: i.closest('.strength-card').getBoundingClientRect().right }; });
          return { kinds, bg, shape,
            eyebrow: eb ? eb.textContent.trim() : null, ebBefore: !!(eb && h1 && (eb.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING)), ebPill: ebCs ? parseFloat(ebCs.borderTopLeftRadius) >= 12 && parseFloat(ebCs.paddingLeft) > 0 : false,
            ebInH1: !!(eb && h1 && h1.textContent.includes(eb.textContent.trim())),
            heroImg: heroImgs.map(i => ({ src: i.getAttribute('src'), lazy: i.getAttribute('loading'), alt: i.getAttribute('alt'), ok: i.complete && i.naturalWidth > 0 })),
            heroArtRadius: haCs ? parseFloat(haCs.borderTopLeftRadius) : 0, heroArtShadow: haCs ? haCs.boxShadow : 'none',
            noAlt: imgs.filter(i => !(i.getAttribute('alt') || '').trim()).map(i => i.getAttribute('src')),
            notLazy: imgs.filter(i => !i.closest('.hero-sec') && i.getAttribute('loading') !== 'lazy').map(i => i.getAttribute('src')),
            thumbs, exCols: new Set(tops('.gallery-sec .ex-card')).size, stCols: new Set(tops('.strength-card')).size, tcCols: new Set(tops('.tool-cards .tool-card')).size,
            heroCols: getComputedStyle(document.querySelector('.hero')).gridTemplateColumns.split(' ').length, sImgs,
            over: document.documentElement.scrollWidth - vw, demoIn: (() => { const d = document.querySelector('.demo-input'); if (!d) return false; const b = d.getBoundingClientRect(); return b.left >= 0 && b.right <= vw; })() };
        }, ORDER);
        if (r.kinds.join('>') !== ORDER.join('>')) fail(L + '구역 순서가 달라요 (' + r.kinds.join(' > ') + ')');
        if (r.kinds.indexOf('gallery-sec') > r.kinds.indexOf('strengths-sec')) fail(L + '예시 갤러리가 강점 카드보다 뒤에 있어요');
        for (let i = 1; i < r.bg.length; i++) if (r.bg[i] === r.bg[i - 1]) fail(L + '이웃한 구역의 배경이 같아요 (' + r.kinds[i - 1] + ', ' + r.kinds[i] + ')');
        if (r.eyebrow !== eyebrow) fail(L + 'eyebrow 문구가 달라요 (' + r.eyebrow + ')');
        if (!r.ebBefore || !r.ebPill) fail(L + 'eyebrow가 제목 위의 알약 모양 라벨이 아니에요');
        if (r.ebInH1) fail(L + 'eyebrow 문구가 제목과 겹쳐요');
        if (r.heroImg.length !== 1 || !/amour\.png$/.test(r.heroImg[0].src) || !r.heroImg[0].ok) fail(L + '히어로 시연 그림이 amour 예시 이미지가 아니거나 안 보여요 (' + JSON.stringify(r.heroImg) + ')');
        else { if (r.heroImg[0].lazy === 'lazy') fail(L + '히어로 이미지가 lazy로 되어 있어요'); if (!r.heroImg[0].alt) fail(L + '히어로 이미지에 alt가 없어요'); }
        if (r.heroArtRadius < 16 || r.heroArtShadow === 'none') fail(L + '히어로 그림이 둥근 모서리·그림자 카드로 보이지 않아요');
        if (!r.demoIn) fail(L + '"글자 → 도안" 입력 표시가 화면 밖으로 나가요');
        if (r.noAlt.length) fail(L + 'alt가 없는 이미지: ' + r.noAlt.join(', '));
        if (r.notLazy.length) fail(L + '아래쪽 이미지인데 loading="lazy"가 없어요: ' + r.notLazy.join(', '));
        r.thumbs.forEach((t, i) => {
          if (!t.loaded) fail(L + '예시 ' + (i + 1) + '번 그림이 안 불러와져요');
          else if (Math.abs(t.natural - t.shown) / t.natural > 0.03 && t.contain !== 'contain') fail(L + '예시 ' + (i + 1) + '번 그림 비율이 깨졌어요');
        });
        if (r.over > 1) fail(L + '가로로 ' + r.over + 'px 넘쳐요');
        if (w === 1440) {
          if (r.heroCols !== 2 || r.exCols !== 3 || r.stCols !== 2 || r.tcCols !== 2) fail(L + 'PC 배치가 달라요 (히어로 ' + r.heroCols + '열, 예시 ' + r.exCols + '열, 강점 ' + r.stCols + '열, 도구 ' + r.tcCols + '열)');
          if (r.thumbs.some(t => t.fillW < 0.98)) fail(L + '예시 그림이 그림 칸 너비를 꽉 채우지 않아요');
        } else if (r.heroCols !== 1 || r.exCols !== 1 || r.stCols !== 1 || r.tcCols !== 1) fail(L + '휴대폰에서 1열로 쌓이지 않아요 (히어로 ' + r.heroCols + ', 예시 ' + r.exCols + ', 강점 ' + r.stCols + ', 도구 ' + r.tcCols + ')');
        // 강점 카드 그림: 첫 카드 = You are my home 예시, 둘째 카드 = 하트 방안뜨기 기호도 (한·영 같은 파일)
        const WANT = [['you-are-my-home.png', /문구|text/i, '문구 카드'], ['filet-heart.webp', /방안뜨기|filet/i, '방안뜨기 카드']];
        if (r.sImgs.length !== 2) fail(L + '강점 카드 그림이 2개가 아니에요 (' + r.sImgs.length + ')');
        else {
          r.sImgs.forEach((g, k) => {
            const [file, cardRe, name] = WANT[k];
            if (g.file !== file || !g.ok) fail(L + name + ' 그림(' + file + ')이 안 보여요 (' + g.src + ')');
            if (!cardRe.test(g.inCard)) fail(L + name + ' 그림이 다른 카드에 있어요 (' + g.inCard + ')');
            if (!g.alt || g.lazy !== 'lazy') fail(L + name + ' 그림에 alt나 loading="lazy"가 없어요');
            if (g.ratio > 0.03) fail(L + name + ' 그림 비율이 깨졌어요');
            if (g.radius < 8 || !g.border) fail(L + name + ' 그림 칸에 둥근 모서리·테두리가 없어요');
            if (g.natW < g.shownW * 1.5) fail(L + name + ' 그림 해상도가 표시 크기의 2배에 못 미쳐요 (' + g.natW + ' / ' + Math.round(g.shownW) + ')');
            if (!g.inBox || g.boxRight > g.cardRight + 1) fail(L + name + ' 그림이 칸이나 카드 밖으로 넘쳐요');
            if (g.shownH > 301) fail(L + name + ' 그림 높이가 300px을 넘어요 (' + Math.round(g.shownH) + ')');
          });
          const [a, h] = r.sImgs;
          // 하트 기호도: 기호가 뭉개지지 않게 충분히 크게 (도안 12단이 이 높이 안에 들어감)
          if (h.shownH < (w === 1440 ? 280 : 200)) fail(L + '하트 기호도가 너무 작게 보여요 (높이 ' + Math.round(h.shownH) + 'px)');
          if (w === 1440 && (a.boxTop !== h.boxTop || a.boxH !== h.boxH)) fail(L + 'PC에서 두 카드 그림 칸의 위치·높이가 달라요 (' + a.boxTop + '/' + a.boxH + ', ' + h.boxTop + '/' + h.boxH + ')');
        }
        shapes[p] = r.shape;
        errors.forEach(e => fail(L + e));
      } finally { await ctx.close(); }
    }
  }
  if (shapes['/'] !== shapes['/en/']) fail('한국어·영어 홈 구조가 달라요 (' + shapes['/'] + ' / ' + shapes['/en/'] + ')');
  // 히어로 이미지는 파일에서도 lazy가 아님, 영어 "See examples"(#examples)가 갤러리로 감
  for (const [file, label] of [['index.html', '홈'], ['en/index.html', '영어 홈']]) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!/<section class="home-sec alt gallery-sec">[\s\S]*?id="examples"/.test(html)) fail(label + ': 예시 갤러리 제목에 id="examples"가 없어요');
  }
  const imgSize = fs.statSync(path.join(ROOT, 'assets/filet-heart.webp')).size;
  if (imgSize > 100 * 1024) fail('assets/filet-heart.webp가 100KB를 넘어요 (' + Math.round(imgSize / 1024) + 'KB)');
  if (fs.existsSync(path.join(ROOT, 'assets/filet-amour.webp'))) fail('더 이상 쓰지 않는 assets/filet-amour.webp가 남아 있어요');
  // 하트 예시(방안뜨기 그림의 원본): 13코 × 12단, 흰 바탕 + 빨강 #FF0000, 예시 페이지 링크 = 도안 파일
  const heart = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/img/heart-coaster.json'), 'utf8'));
  if (heart.cols !== 13 || heart.rows !== 12 || heart.bg.toUpperCase() !== '#FFFFFF' || heart.colors.join() !== '#FF0000') fail('하트 예시 도안이 13×12, 흰 바탕 + #FF0000이 아니에요 (' + heart.cols + '×' + heart.rows + ', ' + heart.bg + ', ' + heart.colors.join(' ') + ')');
  const exHtml = fs.readFileSync(path.join(ROOT, 'examples/index.html'), 'utf8');
  const hCard = (exHtml.match(/<article class="card ex-card">(?:(?!<\/article>)[\s\S])*heart-coaster\.png[\s\S]*?<\/article>/) || [''])[0];
  const hLink = (hCard.match(/#p=([A-Za-z0-9_-]+)/) || [])[1];
  if (!hLink) fail('예시 페이지에서 하트 링크를 찾지 못했어요');
  else if (diffCells(decodePattern(fromHash(hLink)).data, decodePattern(heart).data) || fromHash(hLink).cols !== 13 || fromHash(hLink).rows !== 12) fail('예시 페이지의 하트 링크가 heart-coaster.json과 달라요');
  if (!/13코 × 12단 · 2색/.test(hCard) || /20코/.test(hCard)) fail('예시 페이지 하트 카드의 크기 표기가 13코 × 12단이 아니에요');
  note('한·영 × 1440·390·320px × 라이트·다크, 구조 ' + shapes['/'] + ', 방안뜨기 그림 ' + Math.round(imgSize / 1024) + 'KB');
});

test('소개 페이지 글꼴: 제목·로고 글꼴만 preload(모두 실제로 쓰임, 경로·crossorigin 맞음), 바깥 요청 없음, 대체 글꼴 크기 보정', async (fail, note) => {
  const PAGES = ['/', '/en/', '/examples/', '/guides/', '/guides/reading-charts/', '/guides/lettering-size/', '/guides/knitting-direction/', '/guides/patchwork-practice/', '/about/', '/privacy/', '/credits/', '/counter/', '/404.html'];
  // 본고딕 묶음 파일 → unicode-range 첫 구간 (브라우저의 FontFace와 맞춰 보려고)
  const fcss = fs.readFileSync(path.join(ROOT, 'assets/fonts/noto-sans-kr.css'), 'utf8');
  const rangeOf = {};
  for (const m of fcss.matchAll(/src: url\(([^)]+)\)[^;]*;\s*unicode-range: ([^;]+);/g)) rangeOf[m[1].split('/').pop()] = m[2].split(',')[0].trim().toUpperCase();
  let total = 0;
  for (const p of PAGES) for (const [w, mobile] of (p === '/' || p === '/en/' ? [[360, true], [1440, false]] : [[360, true]])) {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const outside = [], bad = [], warn = [];
    page.on('request', r => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(BASE) && !isAdScript(u)) outside.push(u); }); // 광고 코드 주소만 예외
    page.on('requestfinished', r => { if (/\.woff2/.test(r.url()) && r.response() && r.response().status() >= 400) bad.push(r.url()); });
    page.on('requestfailed', r => { if (/\.woff2/.test(r.url())) bad.push(r.url()); });
    page.on('console', m => { if (/preload/i.test(m.text())) warn.push(m.text().slice(0, 140)); });
    try {
      await page.setViewport({ width: w, height: 800, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
      await page.goto(BASE + p, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      const r = await page.evaluate(() => {
        const pre = [...document.querySelectorAll('link[rel="preload"][as="font"]')].map(l => ({ href: l.href, file: l.getAttribute('href').split('/').pop(), co: l.hasAttribute('crossorigin'), type: l.getAttribute('type') }));
        const faces = []; document.fonts.forEach(ff => { if (ff.family.replace(/["']/g, '') === 'Noto Sans KR') faces.push({ r: ff.unicodeRange.split(',')[0].trim().toUpperCase(), st: ff.status }); });
        const fam = getComputedStyle(document.body).fontFamily;
        const sheetPos = (() => { const links = [...document.head.querySelectorAll('link')]; const iCss = links.findIndex(l => /noto-sans-kr\.css/.test(l.href)); return links.findIndex(l => l.rel === 'preload') < iCss; })();
        return { pre, faces, fam, sheetPos };
      });
      const L = p + ' ' + w + 'px: ';
      if (!r.pre.length) fail(L + '글꼴 preload가 없어요');
      if (r.pre.length > 10) fail(L + '글꼴 preload가 너무 많아요 (' + r.pre.length + '개)');
      if (!r.sheetPos) fail(L + 'preload가 글꼴 CSS보다 뒤에 있어요');
      for (const x of r.pre) {
        total++;
        if (!x.co || x.type !== 'font/woff2') fail(L + x.file + ': crossorigin이나 type이 빠졌어요 (빠지면 두 번 받아요)');
        if (!rangeOf[x.file]) { fail(L + x.file + ': 글꼴 CSS에 없는 파일이에요'); continue; }
        const face = r.faces.find(ff => ff.r === rangeOf[x.file]);
        if (!face || face.st !== 'loaded') fail(L + x.file + ': preload했는데 이 화면에서 쓰이지 않아요 (' + (face ? face.st : '없음') + ')');
      }
      if (!/^"?Noto Sans KR"?, "?Noto Sans KR Fallback"?/.test(r.fam)) fail(L + '글꼴 순서가 본고딕 → 보정된 대체 글꼴이 아니에요 (' + r.fam.slice(0, 60) + ')');
      if (bad.length) fail(L + '글꼴 파일을 못 받았어요: ' + bad.join(', '));
      if (outside.length) fail(L + '바깥 사이트 요청이 있어요: ' + outside.slice(0, 3).join(', '));
      if (warn.length) fail(L + 'preload 경고: ' + warn.join(' / '));
    } finally { await ctx.close(); }
  }
  // 대체 글꼴(맑은 고딕을 본고딕 크기로 맞춘 것)의 글자 폭이 본고딕과 2% 안으로 같은지 (맑은 고딕이 있는 윈도우에서만)
  {
    const t = await BROWSER.createBrowserContext(); const page = await t.newPage();
    try {
      await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
      const r = await page.evaluate(async () => {
        if (!(await document.fonts.load('16px "Malgun Gothic"', '가')).length && !document.fonts.check('16px "Malgun Gothic"')) {}
        const out = [];
        for (const [txt, wgt] of [['글자로 만드는 코바늘 도안', 700], ['이름이나 기념 문구를 입력하면 배색 도안이 바로 만들어지고', 400], ['Turn words into crochet charts', 700], ['Turn any name or phrase into an alpha pattern', 400]]) {
          const wOf = async fam => { const sp = document.createElement('span'); sp.style.cssText = 'position:absolute;white-space:nowrap;font:' + wgt + ' 40px ' + fam; sp.textContent = txt; document.body.appendChild(sp); await document.fonts.load(wgt + ' 40px ' + fam, txt); const x = sp.getBoundingClientRect().width; sp.remove(); return x; };
          const noto = await wOf('"Noto Sans KR"'), fb = await wOf('"Noto Sans KR Fallback", serif'), malgun = await wOf('"Malgun Gothic", serif'), serif = await wOf('serif');
          out.push({ txt: txt.slice(0, 8), wgt, noto, fb, hasMalgun: Math.abs(malgun - serif) > 0.5 });
        }
        return out;
      });
      if (r[0].hasMalgun) for (const x of r) if (Math.abs(x.fb - x.noto) / x.noto > 0.02) fail('대체 글꼴 폭이 본고딕과 2% 넘게 달라요 (' + x.txt + ' ' + x.wgt + ': ' + Math.round(x.fb) + ' / ' + Math.round(x.noto) + ')');
      note('preload ' + total + '곳 확인' + (r[0].hasMalgun ? ', 대체 글꼴 폭 차이 ' + r.map(x => (100 * (x.fb - x.noto) / x.noto).toFixed(1) + '%').join(' ') : ', 맑은 고딕 없음(폭 비교 건너뜀)'));
    } finally { await t.close(); }
  }
});

test('소개 페이지 CSS 캐시 값: site.css를 쓰는 모든 HTML이 같은 ?v= 값', async (fail, note) => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'tools' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.html') ? [path.join(d, e.name)] : []);
  const vals = {};
  for (const file of walk(ROOT)) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/href="([^"]*site\.css[^"]*)"/g)) {
      const v = (m[1].match(/\?v=(\d+)$/) || [])[1];
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (!v) fail(rel + ': site.css에 ?v= 값이 없어요 (' + m[1] + ')');
      else (vals[v] = vals[v] || []).push(rel);
    }
  }
  const keys = Object.keys(vals);
  if (keys.length > 1) fail('site.css ?v= 값이 페이지마다 달라요: ' + keys.map(k => 'v=' + k + ' (' + vals[k].length + '곳)').join(', '));
  note('site.css ?v=' + keys.join(',') + ' · ' + Object.values(vals).flat().length + '개 페이지');
});

test('칠할 색 팔레트 줄 수가 바뀔 때(색 7→12→7→5): 최근 줄·팔레트·옆 버튼 안 겹침, 같은 색 개수면 같은 높이, 추가·삭제·교체·파일 열기·새로고침·회전·예전 접기 단축키 뒤, 320·360·390px 라이트·다크', async (fail, note) => {
  const COLS = ['#222222', '#D32F2F', '#FBC02D', '#1976D2', '#388E3C', '#8E24AA', '#00ACC1', '#F57C00', '#6D4C41', '#E91E63', '#009688', '#3F51B5'];
  // 파일 열기용 도안: 팔레트 12색 (열면 내 팔레트에 없는 색이 더해짐)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dotteugae-pal-'));
  const file12 = path.join(tmp, 'pal12.json');
  fs.writeFileSync(file12, JSON.stringify({ app: 'crochet-pattern-tool', version: 1, cols: 2, rows: 2, bg: '#FFFFFF', colors: ['#222222'], cells: [[1, 1], [0, 3]], palette: COLS }));
  let steps = 0;
  try {
    for (const dark of [false, true]) for (const w of [320, 360, 390]) {
      const ctx = await BROWSER.createBrowserContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
      const L = '/pattern/ ' + w + 'px ' + (dark ? '어두운' : '밝은') + ' 화면';
      try {
        await page.setViewport({ width: w, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
        await page.evaluateOnNewDocument(d => { try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); if (d) localStorage.setItem('crochet-ui-theme', 'dark'); } catch (e) {} }, dark);
        await page.evaluateOnNewDocument(SKIP_START);
        await page.goto(BASE + '/pattern/', { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
        // 4단계부터 화면의 칠할 색은 새 도구 막대(#qbColors: #qbPalette + #qbRecentRow). 묶음 높이 = 첫 색 칸 위 ~ 최근 줄(없으면 마지막 칸) 아래
        // 평소 상태(처음 연 5색 한 줄, 최근 줄 없음)는 칸 한 줄 높이 28px
        const first = await page.evaluate(() => { const its = [...document.querySelectorAll('#qbPalette .swatch, #qbPalette .add-color')].map(e => e.getBoundingClientRect()), rr = document.getElementById('qbRecentRow'); return { recent: !rr.hidden, h: Math.round((rr.hidden ? Math.max(...its.map(b => b.bottom)) : rr.getBoundingClientRect().bottom) - Math.min(...its.map(b => b.top))) }; });
        if (!first.recent && first.h !== 28) fail(L + ': 처음 연 상태(한 줄, 최근 줄 없음)의 묶음 높이가 28px(칸 한 줄)이 아니에요 (' + first.h + 'px)');
        const heights = {}; // 색 개수 → 묶음 높이 (같은 개수면 언제나 같아야 함)
        const check = async (why) => {
          steps++;
          // 최근 색 줄이 보이게 앞쪽 색 세 개를 차례로 고름 (마지막에 고른 첫 색이 선택됨)
          await page.evaluate(() => [2, 1, 0].forEach(i => pickPaintColor(PRESET_COLORS[i]))); await sleep(300);
          const m = await page.evaluate(() => {
            const R = e => e.getBoundingClientRect();
            const hit = (a, b, pad = 0) => a.left - pad < b.right && b.left < a.right + pad && a.top - pad < b.bottom && b.top < a.bottom + pad;
            const pal = document.getElementById('qbPalette'), body = document.getElementById('qbColors'), cap = document.getElementById('qbUndo'); // 라벨 대신 바로 옆 되돌리기 버튼과 겹치는지
            const items = [...pal.querySelectorAll('.swatch, .add-color')], rr = document.getElementById('qbRecentRow'), sel = pal.querySelector('.swatch.selected');
            const rrR = rr.hidden ? null : R(rr);
            return { n: PRESET_COLORS.length, recent: !!rrR, rows: new Set(items.map(i => Math.round(R(i).top))).size, bodyH: Math.round((rrR ? rrR.bottom : Math.max(...items.map(i => R(i).bottom))) - Math.min(...items.map(i => R(i).top))),
              swHit: !!rrR && items.some(i => hit(R(i), rrR)),              // 팔레트 칸과 최근 줄 상자
              ringHit: !!(rrR && sel && hit(R(sel), rrR, 3.5)),            // 선택 고리(바깥 4px)와 최근 줄
              capHit: !!rrR && hit(rrR, R(cap)),                            // 최근 줄과 옆의 되돌리기 버튼
              clipped: pal.scrollHeight > pal.clientHeight + 1,             // 12색까지는 팔레트 안에서 잘리거나 스크롤되면 안 됨
              inBody: items.every(i => R(i).bottom <= R(body).bottom + 0.5) && (!rrR || rrR.bottom <= R(body).bottom + 0.5) };
          });
          const S = L + ' · ' + why + ' (색 ' + m.n + '개, ' + m.rows + '줄): ';
          if (!m.recent) { fail(S + '최근 색 줄이 안 보여요'); return; }
          if (m.swHit) fail(S + '최근 색 줄이 팔레트 칸과 겹쳐요');
          if (m.ringHit) fail(S + '선택한 색의 고리가 최근 색 줄에 닿아요');
          if (m.capHit) fail(S + '최근 색 줄이 옆의 되돌리기 버튼과 겹쳐요');
          if (m.clipped) fail(S + '팔레트 칸이 잘리거나 안에서 스크롤돼요');
          if (!m.inBody) fail(S + '팔레트나 최근 줄이 묶음 밖으로 삐져나가요');
          if (heights[m.n] === undefined) heights[m.n] = m.bodyH;
          else if (heights[m.n] !== m.bodyH) fail(S + '같은 색 개수인데 묶음 높이가 달라요 (' + heights[m.n] + 'px → ' + m.bodyH + 'px)');
        };
        const replace = async n => { await page.evaluate((cs, n) => { PRESET_COLORS.length = 0; cs.slice(0, n).forEach(c => PRESET_COLORS.push(c)); activeColor = PRESET_COLORS[0]; buildPalette(); }, COLS, n); await sleep(250); };
        const add = async c => {
          await page.evaluate(() => document.querySelector('#qbPalette .add-color').click()); await sleep(150);
          await page.evaluate(c => { const t = document.getElementById('hexText'); t.value = c; t.dispatchEvent(new Event('input')); document.getElementById('hexOk').click(); }, c); await sleep(200);
        };
        const del = async () => { await page.evaluate(() => { openSwatchMenu(PRESET_COLORS.length - 1); document.getElementById('swatchDelete').click(); }); await sleep(200); };
        // 7 → 12 → 7 → 5 (교체 · 추가 · 삭제 · 교체)
        await replace(7); await check('팔레트 교체로 7개');
        for (const c of COLS.slice(7)) await add(c); await check('색 추가로 12개');
        for (let k = 0; k < 5; k++) await del(); await check('색 삭제로 다시 7개');
        await replace(5); await check('팔레트 교체로 5개');
        // 파일 열기 (팔레트 12색이 더해짐) → 삭제로 7개
        const input = await page.$('#openFileInput');
        await input.uploadFile(file12); await sleep(500); await check('파일 열기 뒤');
        for (let k = 0; k < 5; k++) await del(); await check('파일 연 뒤 삭제로 7개');
        // 예전 작업창 접기 단축키(Ctrl+\, 5a에서 없앰) 두 번: 아무 동작이 없으니 화면 배치가 그대로여야 함
        for (let k = 0; k < 2; k++) { await page.keyboard.down('Control'); await page.keyboard.press('Backslash'); await page.keyboard.up('Control'); await sleep(200); }
        await check('예전 접기 단축키 두 번 뒤');
        // 화면 돌리기(가로 → 세로)
        await page.setViewport({ width: 760, height: w, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); await sleep(300);
        await page.setViewport({ width: w, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); await sleep(300); await check('화면 돌린 뒤');
        // 12개로 늘린 채 새로고침 → 다시 7개
        for (const c of COLS.slice(7)) await add(c); await check('다시 12개');
        await page.reload({ waitUntil: 'networkidle0', timeout: 30000 }); await sleep(400);
        await page.evaluate(() => setRibbonFolded(false)); await sleep(250); await check('새로고침 뒤');
        for (let k = 0; k < 5; k++) await del(); await check('새로고침 뒤 삭제로 7개');
        errors.forEach(e => fail(L + ': ' + e));
      } finally { await ctx.close(); }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // PC(1440px, 마우스): 묶음 높이 44px·한 줄 그대로 (최근 줄이 있어도)
  {
    const t = await openPage('/pattern/');
    try {
      await t.page.evaluate(cs => { PRESET_COLORS.length = 0; cs.forEach(c => PRESET_COLORS.push(c)); buildPalette(); [2, 1, 0].forEach(i => pickPaintColor(PRESET_COLORS[i])); }, COLS);
      await sleep(300);
      const r = await t.page.evaluate(() => { const its = [...document.querySelectorAll('#qbPalette .swatch')].map(e => e.getBoundingClientRect()), rr = document.getElementById('qbRecentRow'); return { h: Math.round(rr.getBoundingClientRect().bottom - Math.min(...its.map(b => b.top))), wrap: getComputedStyle(document.getElementById('qbPalette')).flexWrap, recent: !rr.hidden }; });
      if (r.h !== 44 || r.wrap !== 'nowrap' || !r.recent) fail('PC(1440px) 칠할 색 묶음이 바뀌었어요 (' + JSON.stringify(r) + ')');
      t.errors.forEach(e => fail('PC: ' + e));
    } finally { await t.close(); }
  }
  note('320·360·390px × 라이트·다크, 단계 ' + steps + '번 (교체·추가·삭제·파일 열기·예전 접기 단축키·회전·새로고침), PC 그대로');
}, { limitMin: 4 }); // 단계가 많아 느린 컴퓨터에서 2분에 거의 닿아서 4분

test('새 도구 막대(3단계): 막대 버튼이 기존 버튼과 같은 동작, 저장 메뉴·더보기 메뉴(키보드·바깥 누르기·Esc·Tab), 글자 버튼, 막대의 칠할 색·최근 색, 휴대폰 막대의 되돌리기·다시하기·작업 시작하기, 방안뜨기에서 숨김, 휴대폰 360px, 영어', async (fail, note) => {
  const vis = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  const expanded = (page, id) => page.evaluate(i => document.getElementById(i).getAttribute('aria-expanded'), id);
  const focused = page => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || (a.dataset && (a.dataset.click || a.dataset.pane)) || a.className) : ''; });
  const press = async (page, key) => { await page.keyboard.press(key); await sleep(120); };
  const downloads = async (page, ctx) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotteugae-qb-'));
    const cdp = await page.createCDPSession();
    try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId: ctx.id }); }
    catch (e) { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); }
    return dir;
  };
  const waitFile = async (dir, ext, before) => {
    for (let i = 0; i < 50; i++) { const f = fs.readdirSync(dir).find(n => n.endsWith(ext) && !before.includes(n)); if (f) { await sleep(300); return f; } await sleep(200); }
    return null;
  };
  // 1) PC 한국어: 막대 버튼·메뉴 동작
  {
    const t = await openPage('/pattern/');
    const dir = await downloads(t.page, t.ctx);
    try {
      const { page } = t;
      if (!await vis(page, '#qbar')) fail('PC: 새 도구 막대가 보이지 않아요');
      if (!await vis(page, '#qbColors')) fail('PC: 새 도구 막대에 칠할 색 줄이 보이지 않아요'); // 4단계부터 항상 보임
      // 칠하기·채우기·지우개 = 작업창 버튼·지우개 칸과 같은 상태
      await clickId(page, 'qbFill');
      let s = await page.evaluate(() => ({ tool, fillOn: toolFillBtn.classList.contains('active'), qb: document.getElementById('qbFill').getAttribute('aria-pressed') }));
      if (s.tool !== 'fill' || !s.fillOn || s.qb !== 'true') fail('PC: 막대의 채우기가 작업창 채우기와 같은 상태가 아니에요 (' + JSON.stringify(s) + ')');
      await clickId(page, 'qbEraser');
      s = await page.evaluate(() => ({ c: activeColor, sel: !!document.querySelector('#palette .swatch.eraser.selected'), qb: document.getElementById('qbEraser').getAttribute('aria-pressed') }));
      if (s.c !== null || !s.sel || s.qb !== 'true') fail('PC: 막대의 지우개가 팔레트 지우개 칸과 같은 동작이 아니에요 (' + JSON.stringify(s) + ')');
      await clickId(page, 'qbPaint');
      s = await page.evaluate(() => ({ tool, c: activeColor, paintOn: toolPaintBtn.classList.contains('active'), qb: document.getElementById('qbPaint').getAttribute('aria-pressed'), er: document.getElementById('qbEraser').getAttribute('aria-pressed') }));
      if (s.tool !== 'paint' || !s.c || !s.paintOn || s.qb !== 'true' || s.er !== 'false') fail('PC: 지우개 다음에 칠하기를 누르면 칠하기·색으로 돌아와야 해요 (' + JSON.stringify(s) + ')');
      // 되돌리기·다시하기
      await pickColor(page, RED); await clickCell(page, 0, 0);
      const und = await page.evaluate(() => [document.getElementById('qbUndo').disabled, document.getElementById('undoBtn').disabled, document.getElementById('qbRedo').disabled, document.getElementById('redoBtn').disabled]);
      if (und[0] !== und[1] || und[2] !== und[3]) fail('PC: 막대의 되돌리기·다시하기 꺼짐 상태가 맨 위 버튼과 달라요 (' + und + ')');
      await clickId(page, 'qbUndo');
      if (await page.evaluate(() => !!gridData[0])) fail('PC: 막대의 되돌리기를 눌렀는데 칠한 칸이 그대로예요');
      await clickId(page, 'qbRedo');
      if (!(await page.evaluate(() => !!gridData[0]))) fail('PC: 막대의 다시하기를 눌렀는데 칸이 돌아오지 않았어요');
      // 저장 메뉴: 마우스로 열기 → 항목 2개(PC는 공유 없음) → 바깥 누르면 닫힘
      await page.click('#qbSave'); await sleep(150);
      const items = await page.evaluate(() => [...document.querySelectorAll('#qbSaveMenu .qb-mi')].filter(i => i.getClientRects().length > 0).map(i => i.dataset.click || i.id)); // 화면에 실제로 보이는 항목만
      if (!await vis(page, '#qbSaveMenu') || await expanded(page, 'qbSave') !== 'true') fail('PC: 저장 버튼을 눌렀는데 메뉴가 열리지 않았어요');
      if (JSON.stringify(items) !== JSON.stringify(['saveFileBtn', 'saveImgBtn', 'qbUrlItem'])) fail('PC: 저장 메뉴 항목이 "도안 파일 저장·이미지로 저장·이미지에 사이트 주소 넣기"가 아니에요 (' + items + ')');
      const kbd = await page.evaluate(() => document.querySelector('#qbSaveMenu .qb-kbd').textContent);
      if (kbd !== 'Ctrl+S') fail('PC: 저장 메뉴에 단축키 Ctrl+S 표시가 없어요 (' + kbd + ')');
      const sb = await page.evaluate(() => { const r = document.querySelector('.statusbar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.click(sb.x, sb.y); await sleep(150);
      if (await vis(page, '#qbSaveMenu') || await expanded(page, 'qbSave') !== 'false') fail('PC: 메뉴 바깥을 눌렀는데 저장 메뉴가 닫히지 않았어요');
      // 키보드: Enter로 열면 첫 항목, ↓↑ 이동(처음·끝에서 돌아감), End, Esc면 닫히고 버튼으로
      await page.focus('#qbSave'); await press(page, 'Enter');
      if (await focused(page) !== 'saveFileBtn') fail('PC: Enter로 저장 메뉴를 열면 첫 항목에 있어야 하는데 "' + await focused(page) + '"이에요');
      await press(page, 'ArrowDown');
      if (await focused(page) !== 'saveImgBtn') fail('PC: 저장 메뉴에서 ↓를 눌렀는데 다음 항목으로 가지 않았어요');
      await press(page, 'ArrowDown');
      if (await focused(page) !== 'qbUrlItem') fail('PC: 저장 메뉴에서 ↓를 두 번 누르면 "이미지에 사이트 주소 넣기"로 가야 해요');
      await press(page, 'ArrowDown');
      if (await focused(page) !== 'saveFileBtn') fail('PC: 저장 메뉴 마지막에서 ↓를 누르면 처음으로 돌아가야 해요');
      await press(page, 'ArrowUp');
      if (await focused(page) !== 'qbUrlItem') fail('PC: 저장 메뉴 처음에서 ↑를 누르면 마지막으로 가야 해요');
      await press(page, 'Home');
      if (await focused(page) !== 'saveFileBtn') fail('PC: 저장 메뉴에서 Home이 첫 항목으로 가지 않아요');
      await press(page, 'Escape');
      if (await vis(page, '#qbSaveMenu') || await focused(page) !== 'qbSave') fail('PC: Esc를 누르면 저장 메뉴가 닫히고 저장 버튼으로 돌아가야 해요');
      await press(page, ' ');
      if (!await vis(page, '#qbSaveMenu')) fail('PC: Space로 저장 메뉴가 열리지 않아요');
      await press(page, 'Tab');
      if (await vis(page, '#qbSaveMenu')) fail('PC: Tab으로 메뉴 밖으로 나가면 메뉴가 닫혀야 해요');
      // 저장 메뉴 항목 = 기존 저장 동작: 도안 파일(JSON)과 PNG가 내려받아짐. Ctrl+S도 그대로
      let before = fs.readdirSync(dir);
      await page.click('#qbSave'); await sleep(120);
      await page.click('#qbSaveMenu .qb-mi[data-click="saveFileBtn"]');
      let f = await waitFile(dir, '.json', before);
      if (!f) fail('PC: 저장 메뉴의 "도안 파일 저장"을 눌렀는데 도안 파일이 내려받아지지 않았어요');
      else { const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); const g = decodePattern(o); if (o.app !== 'crochet-pattern-tool' || o.version !== 1 || g.data[0] !== RED) fail('PC: 메뉴로 저장한 도안 파일 내용이 달라요'); }
      if (await vis(page, '#qbSaveMenu')) fail('PC: 저장 메뉴 항목을 누른 뒤에도 메뉴가 열려 있어요');
      before = fs.readdirSync(dir);
      await page.click('#qbSave'); await sleep(120);
      await page.click('#qbSaveMenu .qb-mi[data-click="saveImgBtn"]');
      f = await waitFile(dir, '.png', before);
      if (!f) fail('PC: 저장 메뉴의 "이미지로 저장"을 눌렀는데 PNG가 내려받아지지 않았어요');
      else if (fs.readFileSync(path.join(dir, f)).readUInt32BE(0) !== 0x89504E47) fail('PC: 메뉴로 저장한 이미지가 PNG가 아니에요');
      // Ctrl+S는 그대로 같은 저장 함수를 부름 (브라우저가 같은 페이지의 연속 내려받기를 막으므로 파일 대신 호출 여부로 확인)
      await page.mouse.click(sb.x, sb.y);
      await page.evaluate(() => { window.__saveOrig = savePatternFile; window.__saves = 0; savePatternFile = function () { window.__saves++; }; });
      await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(150);
      if (await page.evaluate(() => { const n = window.__saves; savePatternFile = window.__saveOrig; return n; }) !== 1) fail('PC: Ctrl+S가 도안 파일 저장으로 동작하지 않아요');
      // 열기 버튼 = 기존 열기 (파일 고르기 창)
      const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }).catch(() => null), page.click('#qbOpen')]);
      if (!chooser) fail('PC: 막대의 열기를 눌렀는데 파일 고르기 창이 뜨지 않았어요'); else await chooser.cancel().catch(() => {});
      // 더보기 메뉴: 모든 항목이 기존 버튼(또는 패널 탭)과 이어져 있음
      await page.click('#qbMore'); await sleep(150);
      const mr = await page.evaluate(() => {
        const m = document.getElementById('qbMoreMenu'), r = m.getBoundingClientRect();
        const its = [...m.querySelectorAll('.qb-mi')];
        return { shown: !m.hidden, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0, n: its.length,
          broken: its.filter(i => i.dataset.click ? !document.getElementById(i.dataset.click) : !document.getElementById('pane-' + i.dataset.pane)).map(i => i.textContent.trim()),
          clicks: its.map(i => i.dataset.click || 'pane:' + i.dataset.pane), groups: [...m.querySelectorAll('.qb-mg')].map(g => g.getAttribute('aria-label')),
          copyOff: m.querySelector('[data-click="copyBtn"]').disabled, pasteOff: m.querySelector('[data-click="pasteBtn"]').disabled };
      });
      if (!mr.shown || !mr.inView) fail('PC: 더보기 메뉴가 열리지 않았거나 화면 밖으로 나가요');
      if (mr.broken.length) fail('PC: 더보기 메뉴에 기존 버튼과 이어지지 않은 항목이 있어요 (' + mr.broken + ')');
      ['toolSelectBtn', 'zoomOutBtn', 'zoomInBtn', 'zoomResetBtn', 'filetBtn', 'rowMinusBtn', 'rowPlusBtn', 'flipToggleBtn', 'rot90Btn', 'rot270Btn', 'copyBtn', 'pasteBtn', 'clearGridBtn', 'copyLinkBtn', 'pane:decor', 'pane:replace', 'pane:grid', 'pane:help']
        .forEach(k => { if (!mr.clicks.includes(k)) fail('PC: 더보기 메뉴에 ' + k + ' 항목이 없어요'); });
      if (!mr.copyOff || !mr.pasteOff) fail('PC: 떠 있는 것이 없는데 더보기의 복사·붙여넣기가 켜져 있어요 (기존 버튼과 다름)');
      // 확대: 메뉴가 열린 채로 비율이 바뀜
      await page.click('#qbMoreMenu [data-click="zoomInBtn"]'); await sleep(150);
      s = await page.evaluate(() => ({ z: zoomLevel, val: document.getElementById('qbZoomVal').textContent, open: !document.getElementById('qbMoreMenu').hidden }));
      if (s.z !== 1.25 || s.val !== '125%' || !s.open) fail('PC: 더보기의 확대가 기존 확대와 같지 않아요 (' + JSON.stringify(s) + ')');
      await page.click('#qbMoreMenu [data-click="zoomResetBtn"]'); await sleep(150);
      await page.click('#qbMoreMenu [data-click="rowPlusBtn"]'); await sleep(150);
      s = await page.evaluate(() => ({ r: currentRow, val: document.getElementById('qbRowVal').textContent }));
      if (s.r !== 2 || !/2/.test(s.val)) fail('PC: 더보기의 작업 단 ＋가 기존 버튼과 같지 않아요 (' + JSON.stringify(s) + ')');
      // 좌우 뒤집기: 체크 표시가 기존 버튼 상태와 같음
      await page.click('#qbMoreMenu [data-click="flipToggleBtn"]'); await sleep(150);
      if (!(await page.evaluate(() => flipped && flipToggleBtn.classList.contains('active')))) fail('PC: 더보기의 좌우 뒤집기가 동작하지 않아요');
      await page.click('#qbMore'); await sleep(120);
      if (await page.evaluate(() => document.getElementById('qbFlipItem').getAttribute('aria-checked')) !== 'true') fail('PC: 뒤집은 뒤 더보기의 좌우 뒤집기에 켜짐 표시가 없어요');
      await page.click('#qbMoreMenu [data-click="flipToggleBtn"]'); await sleep(120);
      // 90° 회전
      const g0 = await grid(page);
      await page.click('#qbMore'); await sleep(120);
      await page.click('#qbMoreMenu [data-click="rot90Btn"]'); await sleep(200);
      let g1 = await grid(page);
      if (g1.rows !== g0.cols || g1.cols !== g0.rows) fail('PC: 더보기의 90° 회전이 동작하지 않아요');
      await clickId(page, 'qbUndo');
      // 모두 지우기: 기존 버튼과 같이 바로 지우고, 되돌리기로 돌아옴
      await page.click('#qbMore'); await sleep(120);
      await page.click('#qbMoreMenu [data-click="clearGridBtn"]'); await sleep(200);
      if ((await grid(page)).data.some(Boolean)) fail('PC: 더보기의 모두 지우기를 눌렀는데 칸이 남아 있어요');
      await clickId(page, 'qbUndo');
      if (!(await grid(page)).data.some(Boolean)) fail('PC: 모두 지우기 뒤 되돌리기로 돌아오지 않아요');
      // 5a: 더보기 > "격자 크기·배경색·게이지" → 격자 탭. 도안 파일 묶음은 안 보이고 나머지 설정은 그대로 보임
      await page.click('#qbMore'); await sleep(120);
      await page.click('#qbMoreMenu [data-pane="grid"]'); await sleep(200);
      s = await page.evaluate(() => {
        const vis = sel => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0; };
        return { active: document.getElementById('pane-grid').classList.contains('active'), rows: vis('#rowsInput'), bg: vis('#bgPalette'), gauge: vis('#gaugePreset'), margin: vis('#marginDirSelect'), fileSec: vis('.file-sec'), open: !document.getElementById('qbMoreMenu').hidden };
      });
      if (!s.active) fail('PC: 더보기의 "격자 크기·배경색·게이지"를 눌렀는데 격자 탭이 열리지 않았어요');
      if (!s.rows || !s.bg || !s.gauge || !s.margin) fail('PC: 격자 탭의 격자 크기·배경색·게이지·여백 중 안 보이는 것이 있어요 (' + JSON.stringify(s) + ')');
      if (s.fileSec) fail('PC: 격자 탭에 "도안 파일" 묶음이 아직 보여요');
      if (s.open) fail('PC: "격자 크기·배경색·게이지"를 고른 뒤에도 더보기 메뉴가 열려 있어요');
      // 5a: 더보기 > 링크 복사 = 숨은 copyLinkBtn과 같은 동작 (지금 도안이 담긴 #p= 링크)
      await page.evaluate(() => { window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async v => { window.__clip = v; } } }); });
      await page.click('#qbMore'); await sleep(120);
      await page.click('#qbMoreMenu [data-click="copyLinkBtn"]'); await sleep(300);
      {
        const clip = await page.evaluate(() => window.__clip);
        const m = clip && clip.match(/#p=([A-Za-z0-9_-]+)$/);
        if (!m) fail('PC: 더보기의 링크 복사가 도안 링크(#p=…)를 복사하지 않았어요 (' + clip + ')');
        else { const lg = decodePattern(fromHash(m[1])), cur = await grid(page); if (lg.rows !== cur.rows || lg.cols !== cur.cols || diffCells(lg.data, cur.data)) fail('PC: 더보기에서 복사한 링크의 도안이 화면의 도안과 달라요'); }
      }
      // 패널 탭 항목 (장식)
      await page.click('#qbMore'); await sleep(120);
      await page.click('#qbMoreMenu [data-pane="decor"]'); await sleep(200);
      if (!(await page.evaluate(() => document.getElementById('pane-decor').classList.contains('active')))) fail('PC: 더보기의 장식을 눌렀는데 장식 탭이 열리지 않았어요');
      // 키보드로 더보기: ↓로 열고 End → 마지막(도움말) → Enter
      await page.focus('#qbMore'); await press(page, 'ArrowDown');
      if (await focused(page) !== 'toolSelectBtn') fail('PC: ↓로 더보기를 열면 첫 항목(선택)에 있어야 해요 (' + await focused(page) + ')');
      await press(page, 'End');
      if (await focused(page) !== 'help') fail('PC: 더보기에서 End를 누르면 마지막 항목(도움말)이어야 해요');
      await press(page, 'Enter'); await sleep(150);
      if (!(await page.evaluate(() => document.getElementById('pane-help').classList.contains('active')))) fail('PC: 더보기에서 키보드로 도움말을 골랐는데 도움말 탭이 열리지 않았어요');
      if (await vis(page, '#qbMoreMenu')) fail('PC: 더보기 항목을 고른 뒤에도 메뉴가 열려 있어요');
      // 글자 버튼: 오른쪽 패널의 글자 탭 (새 창 없음)
      await clickId(page, 'qbText');
      s = await page.evaluate(() => ({ pane: document.getElementById('pane-text').classList.contains('active'), modal: !!document.querySelector('.hex-modal.show') }));
      if (!s.pane || s.modal) fail('PC: 글자 버튼을 눌렀는데 오른쪽 패널의 글자 탭이 열리지 않았어요');
      // 막대의 칠할 색 줄 (팔레트와 같은 색, 누르면 칠할 색이 바뀜)
      s = await page.evaluate(() => ({ qb: [...document.querySelectorAll('#qbPalette .swatch')].map(b => b.dataset.color), pal: PRESET_COLORS.map(c => c.toUpperCase()) }));
      if (JSON.stringify(s.qb) !== JSON.stringify(s.pal)) fail('PC: 막대의 칠할 색이 팔레트와 달라요 (' + JSON.stringify(s) + ')');
      await page.click('#qbPalette .swatch[data-color="' + BLUE + '"]'); await sleep(150);
      s = await page.evaluate(() => ({ c: activeColor, sel: getComputedStyle(document.querySelector('#palette .swatch.selected')).backgroundColor }));
      if (s.c !== BLUE || s.sel !== hexToRgb(BLUE)) fail('PC: 막대의 색을 눌렀는데 칠할 색이 바뀌지 않았어요 (' + JSON.stringify(s) + ')');
      if (!await vis(page, '#qbRecentRow')) fail('PC: 색을 두 번 바꿨는데 막대에 최근 색 줄이 보이지 않아요');
      await page.click('#qbRecentChips .recent-chip[data-color="' + RED + '"]'); await sleep(150);
      if (await page.evaluate(() => activeColor) !== RED) fail('PC: 막대의 최근 색을 눌렀는데 그 색이 고르지 않았어요');
      await clickCell(page, 1, 1);
      if (await page.evaluate(() => gridData[cols + 1]) !== RED) fail('PC: 막대로 고른 색으로 칠해지지 않아요');
      // 방안뜨기 탭에서는 막대가 숨음 (보기 전용)
      await clickId(page, 'tabFilet');
      if (await vis(page, '#qbar')) fail('PC: 방안뜨기 탭인데 새 도구 막대가 보여요');
      await clickId(page, 'tabDesign');
      if (!await vis(page, '#qbar')) fail('PC: 도안 탭으로 돌아왔는데 새 도구 막대가 안 보여요');
      t.errors.forEach(e => fail('PC: ' + e));
    } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  // 2) 휴대폰(360px, 터치, 파일 공유 가능): 처음엔 작업창이 접혀 있고 막대에 칠할 색, 저장 메뉴에 공유, 글자 버튼은 패널까지 내려감
  {
    const ctx = await BROWSER.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('자바스크립트 오류: ' + String(e.message || e).split('\n')[0]));
    try {
      await page.setViewport({ width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => {
        try { localStorage.setItem('crochet-ribbon-hint-shown', '1'); } catch (e) {}
        window.__shared = 0;
        navigator.canShare = d => !!(d && d.files && d.files.length);
        navigator.share = async () => { window.__shared++; };
      });
      await page.evaluateOnNewDocument(SKIP_START);
      await page.goto(BASE + '/pattern/', { waitUntil: 'networkidle0', timeout: 30000 }); await sleep(300);
      const s = await page.evaluate(() => ({ ribbon: document.getElementById('ribbon').getClientRects().length > 0, coarse: matchMedia('(pointer: coarse)').matches,
        // 4단계: 맨 위 막대에서 뺀 되돌리기·다시하기·작업 시작하기가 휴대폰 새 막대에 있음
        moved: ['qbUndo', 'qbRedo', 'qbKnit', 'qbOpen', 'qbSave', 'qbMore'].filter(id => !document.getElementById(id).getClientRects().length) }));
      if (s.ribbon) fail('360px: 옛 작업창이 화면에 보여요');
      if (s.moved.length) fail('360px: 새 도구 막대에 ' + s.moved.join(', ') + ' 버튼이 보이지 않아요');
      if (!await vis(page, '#qbColors')) fail('360px: 작업창이 접혀 있는데 막대에 칠할 색 줄이 없어요');
      await page.tap('#qbPalette .swatch[data-color="' + RED + '"]'); await sleep(150);
      if (await page.evaluate(() => activeColor) !== RED) fail('360px: 막대의 칠할 색을 눌렀는데 바뀌지 않았어요');
      if (!await vis(page, '#qbRecentRow')) fail('360px: 막대에 최근 색 줄이 보이지 않아요');
      if (s.coarse) {
        await page.tap('#qbSave'); await sleep(150);
        if (!await vis(page, '#qbShareItem')) fail('360px: 파일 공유가 되는 터치 기기인데 저장 메뉴에 공유가 없어요');
        else { await page.tap('#qbShareItem'); if (!await waitFor(page, () => window.__shared > 0, 5000)) fail('360px: 저장 메뉴의 공유가 공유 시트로 넘기지 않았어요'); }
      } else note('터치 흉내가 안 돼서 공유 항목은 건너뜀');
      // 더보기 메뉴가 화면 안에 다 들어옴
      await page.tap('#qbMore'); await sleep(150);
      const m = await page.evaluate(() => { const r = document.getElementById('qbMoreMenu').getBoundingClientRect(); return { l: r.left, r: r.right, vw: document.documentElement.clientWidth }; });
      if (m.l < 0 || m.r > m.vw) fail('360px: 더보기 메뉴가 화면 밖으로 나가요 (' + JSON.stringify(m) + ')');
      await page.tap('#qbMore'); await sleep(120);
      // 글자 버튼: 캔버스 아래의 패널로 내려가서 글자 탭
      await page.tap('#qbText'); await sleep(900);
      const tx = await page.evaluate(() => ({ pane: document.getElementById('pane-text').classList.contains('active'), top: Math.round(document.querySelector('.inspector').getBoundingClientRect().top) }));
      if (!tx.pane) fail('360px: 글자 버튼을 눌렀는데 글자 탭이 열리지 않았어요');
      if (tx.top > 200) fail('360px: 글자 버튼을 눌렀는데 패널이 화면에 보이지 않아요 (위에서 ' + tx.top + 'px)');
      // 맨 위로 돌아오면 막대의 칠할 색 줄이 그대로 보이고, 막대의 되돌리기가 동작 (휴대폰에서 새로 옮긴 버튼)
      await page.evaluate(() => window.scrollTo(0, 0)); await sleep(200);
      if (!await vis(page, '#qbColors')) fail('360px: 막대의 칠할 색 줄이 사라졌어요');
      await page.tap('#qbPalette .swatch[data-color="' + BLUE + '"]'); await sleep(150);
      const cp = await page.evaluate(() => { const r = canvas.getBoundingClientRect(); return { x: r.left + LABEL_SIZE + cellW / 2, y: r.top + LABEL_SIZE + cellH / 2 }; });
      await page.touchscreen.tap(cp.x, cp.y); await sleep(200);
      if (await page.evaluate(() => gridData[0]) !== BLUE) fail('360px: 막대에서 고른 색으로 칠해지지 않아요');
      else { await page.tap('#qbUndo'); await sleep(200); if (await page.evaluate(() => gridData[0]) === BLUE) fail('360px: 휴대폰 막대의 되돌리기가 동작하지 않아요'); }
      errors.forEach(e => fail('360px: ' + e));
    } finally { await ctx.close(); }
  }
  // 3) 영어: 막대·메뉴 문구에 한국어가 남지 않음, 접근성 이름
  {
    const t = await openPage('/en/pattern/');
    try {
      const { page } = t;
      await page.click('#qbSave'); await sleep(120);
      const save = await page.evaluate(() => document.getElementById('qbSaveMenu').innerText);
      await page.click('#qbMore'); await sleep(120);
      const r = await page.evaluate(() => {
        const bar = document.getElementById('qbar');
        const attrs = [...bar.querySelectorAll('[aria-label],[title]')].map(e => (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || ''));
        return { text: document.getElementById('qbMoreMenu').innerText + ' ' + [...bar.querySelectorAll('.qb-btn > span')].map(s => s.textContent).join(' '), attrs: attrs.join(' | '),
          save: document.getElementById('qbSave').getAttribute('aria-label'), more: document.getElementById('qbMore').getAttribute('aria-label'), bar: bar.getAttribute('aria-label') };
      });
      const ko = (save + ' ' + r.text + ' ' + r.attrs).match(/[가-힣][가-힣 ·°]*/g);
      if (ko) fail('영어: 새 도구 막대·메뉴에 한국어가 남아 있어요 (' + [...new Set(ko)].slice(0, 6).join(', ') + ')');
      if (!/Save pattern file/.test(save) || !/Save image/.test(save)) fail('영어: 저장 메뉴 문구가 달라요 (' + save.replace(/\s+/g, ' ') + ')');
      if (r.save !== 'Save' || r.more !== 'More' || r.bar !== 'Quick tools') fail('영어: 막대 접근성 이름이 달라요 (' + [r.save, r.more, r.bar] + ')');
      t.errors.forEach(e => fail('영어: ' + e));
    } finally { await t.close(); }
  }
  note('PC 동작·메뉴 키보드, 휴대폰 360px, 영어');
});

test('새 도구 막대(3단계) 화면 폭: 한·영 × 320·360·390·768·1280·1440px × 라이트·다크 × 예전 접기 값 펼침·접힘 × 메뉴 닫힘·저장·더보기에서 가로 넘침·잘린 버튼 없음, 막대 버튼 10개가 모두 보임', async (fail, note) => {
  let views = 0;
  // 한 페이지를 열어 두고 폭만 바꿈 (터치 기기 흉내는 휴대폰·태블릿 폭과 PC 폭으로 나눠서, 바꿀 때 다시 열리지 않게)
  for (const p of ['/pattern/', '/en/pattern/']) for (const dark of [false, true]) for (const [mobile, sizes] of [[true, [[320, 640], [360, 740], [390, 844], [768, 1024]]], [false, [[1280, 800], [1440, 900]]]]) {
    const t = await openPage(p, { width: sizes[0][0], height: sizes[0][1], mobile });
    try {
      const { page } = t;
      if (dark) await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
      for (const [w, h] of sizes) {
      await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 }); await sleep(250);
      for (const fold of [false, true]) {
        await page.evaluate(f => setRibbonFolded(f), fold); await sleep(200);
        for (const menu of [null, 'qbSave', 'qbMore']) {
          if (menu) { await page.click('#' + menu); await sleep(150); }
          const r = await page.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            const inScroller = el => { for (let q = el.parentElement; q; q = q.parentElement) { const o = getComputedStyle(q).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
            const cut = [...document.querySelectorAll('#qbar button')].filter(e => e.offsetParent !== null && !inScroller(e) && !e.closest('.qb-menu[hidden]'))
              .filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > vw + 1 || b.left < -1 || e.scrollWidth > e.clientWidth + 1); })
              .map(e => e.id || e.dataset.click || e.dataset.pane || e.textContent.trim().slice(0, 12));
            const missing = ['qbPaint', 'qbFill', 'qbEraser', 'qbText', 'qbUndo', 'qbRedo', 'qbKnit', 'qbOpen', 'qbSave', 'qbMore'].filter(id => !document.getElementById(id).getClientRects().length);
            return { over: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw, cut, missing };
          });
          const L = p + ' ' + w + 'px ' + (dark ? '다크' : '라이트') + (fold ? ' 접힘' : ' 펼침') + (menu ? ' ' + menu + ' 메뉴' : '');
          if (r.over > 1) fail(L + ': 가로로 ' + r.over + 'px 넘쳐요');
          if (r.cut.length) fail(L + ': 잘리거나 화면 밖으로 나간 버튼이 있어요 (' + r.cut.join(', ') + ')');
          if (r.missing.length) fail(L + ': 새 도구 막대에 안 보이는 버튼이 있어요 (' + r.missing.join(', ') + ')');
          if (menu) { await page.keyboard.press('Escape'); await sleep(100); }
        }
      }
      views++;
      }
      t.errors.forEach(e => fail(p + (dark ? ' 다크' : ' 라이트') + ': ' + e));
    } finally { await t.close(); }
  }
  note('폭·테마 ' + views + '곳 × 펼침·접힘 × 메뉴 3가지');
});

test('이미지에 사이트 주소 띠: 저장 메뉴 체크(기본 켜짐·새로고침 유지·키보드), 켜면 아래 띠·도안 영역 픽셀 그대로, 끄면 기존 크기, 함수 기본값은 띠 없음, 방안뜨기 PNG, 한·영 문구, 휴대폰', async (fail, note) => {
  // 저장 버튼이 내려받는 PNG를 파일 대신 페이지 안에서 받아 크기를 기록 (연속 내려받기가 막히지 않게)
  const HOOK = () => {
    window.__saved = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && /\.png$/.test(this.download) && this.href.startsWith('blob:')) {
        const name = this.download;
        fetch(this.href).then(r => r.blob()).then(b => createImageBitmap(b)).then(im => window.__saved.push({ name, w: im.width, h: im.height }));
        return;
      }
      return orig.call(this);
    };
  };
  const lastSaved = async (page, n) => { for (let i = 0; i < 40; i++) { const s = await page.evaluate(() => window.__saved); if (s.length >= n) return s[n - 1]; await sleep(150); } return null; };
  const press = async (page, key) => { await page.keyboard.press(key); await sleep(120); };
  const item = page => page.evaluate(() => { const i = document.getElementById('qbUrlItem'); const m = document.getElementById('qbSaveMenu'); return { checked: i.getAttribute('aria-checked'), role: i.getAttribute('role'), label: i.textContent.trim(), open: !m.hidden, store: localStorage.getItem('crochet-export-url'), on: exportUrlOn() }; });
  // 도안 영역 비교: 띠 없음(기본값)과 띠 있음을 같은 화면에서 그려서 위쪽 픽셀이 모두 같은지
  const compare = page => page.evaluate(() => {
    const a = renderExport(), bandNone = exportLastBand, b = renderExport({ url: true }), band = exportLastBand;
    const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, db = b.getContext('2d').getImageData(0, 0, b.width, a.height).data;
    let diff = 0; for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) diff++;
    const bx = b.getContext('2d'), H = a.height, W = b.width;
    const px = (x, y) => [...bx.getImageData(x, y, 1, 1).data].slice(0, 3).join();
    // 띠 안의 글자 색: 왼쪽 절반에 진한 초록(주소), 오른쪽 절반에 연한 초록(설명)
    const count = (x0, x1, test) => { const d = bx.getImageData(x0, H, x1 - x0, b.height - H).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++; return n; };
    const dark = (r, g, bl) => r < 90 && g > 70 && g < 130 && bl < 110 && g > r + 25;
    const soft = (r, g, bl) => r < 150 && g < 180 && g > r + 15 && !(r === 226 && g === 238);
    return { aw: a.width, ah: a.height, bw: b.width, bh: b.height, diff, band, bandNone, bg: [px(1, H + 1), px(W - 2, b.height - 2)],
      darkL: count(0, Math.floor(W / 2), dark), darkR: count(Math.ceil(W / 2), W, dark), softR: count(Math.ceil(W / 2), W, soft), expectH: Math.max(28, Math.round(W * 0.055)) };
  });
  let views = 0;
  // 1) PC 한국어: 기본 켜짐 → 이미지로 저장하면 띠, 끄면 기존 크기, 새로고침 뒤에도 끈 그대로, 키보드로 다시 켬
  {
    const t = await openPage('/pattern/');
    try {
      const { page } = t;
      await page.evaluate(HOOK);
      // 색이 여럿인 도안 (맨 아래 줄·오른쪽 끝 칸까지 칠해서 띠와 맞닿는 곳도 비교)
      await page.evaluate((R, B) => { pushUndo(); for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) if ((i + j) % 3 === 0) gridData[i * cols + j] = (i % 2 ? R : B); gridData[rows * cols - 1] = R; drawGrid(); saveState(); }, RED, BLUE);
      let s = await item(page);
      if (s.checked !== 'true' || !s.on || s.store !== null) fail('처음 온 사람인데 "이미지에 사이트 주소 넣기"가 켜져 있지 않아요 (' + JSON.stringify(s) + ')');
      if (s.role !== 'menuitemcheckbox' || s.label !== '이미지에 사이트 주소 넣기') fail('체크 항목의 역할·문구가 달라요 (' + s.role + ', ' + s.label + ')');
      const r = await compare(page);
      if (r.bandNone) fail('renderExport()를 옵션 없이 부르면 띠가 없어야 해요');
      if (r.bw !== r.aw || r.bh !== r.ah + r.expectH) fail(`띠를 켜면 폭은 같고 높이만 띠(${r.expectH}px)만큼 늘어야 해요 (끔 ${r.aw}×${r.ah}, 켬 ${r.bw}×${r.bh})`);
      if (r.diff) fail(`띠를 켰을 때 도안 영역 픽셀이 끈 것과 달라요 (${r.diff}곳)`);
      if (!r.bg.every(c => c === '226,238,232')) fail('띠 바탕색이 #E2EEE8이 아니에요 (' + r.bg + ')');
      if (!r.band || r.band.url !== 'crochetalpha.com' || r.band.desc !== '무료 코바늘 도안 만들기') fail('띠 문구가 달라요 (' + JSON.stringify(r.band) + ')');
      if (r.darkL < 40 || r.darkR > r.darkL / 4) fail(`띠 왼쪽에 진한 초록 주소 글씨가 보이지 않아요 (왼쪽 ${r.darkL}, 오른쪽 ${r.darkR})`);
      if (r.softR < 20) fail(`띠 오른쪽에 설명 글씨가 보이지 않아요 (${r.softR})`);
      if (r.band && (r.band.pad !== 16 || r.band.urlPx !== Math.round(r.band.h * 0.42))) fail('띠 좌우 여백이 그림 여백(16px)과 다르거나 글씨가 띠 높이에 비례하지 않아요 (' + JSON.stringify(r.band) + ')');
      // 저장 메뉴의 "이미지로 저장" = 켬
      await page.click('#qbSave'); await sleep(150);
      await page.click('#qbSaveMenu .qb-mi[data-click="saveImgBtn"]'); await sleep(200);
      let f = await lastSaved(page, 1);
      if (!f || f.w !== r.bw || f.h !== r.bh) fail('켠 상태에서 이미지로 저장한 PNG에 띠가 없어요 (' + JSON.stringify(f) + ', 기대 ' + r.bw + '×' + r.bh + ')');
      // 마우스로 끄기: 메뉴는 열린 채, 저장값 '0'
      await page.click('#qbSave'); await sleep(150);
      await page.click('#qbUrlItem'); await sleep(150);
      s = await item(page);
      if (s.checked !== 'false' || s.on || s.store !== '0') fail('체크 항목을 눌렀는데 꺼지지 않았어요 (' + JSON.stringify(s) + ')');
      if (!s.open) fail('체크 항목을 누르면 저장 메뉴가 열린 채로 있어야 해요');
      await page.click('#qbSaveMenu .qb-mi[data-click="saveImgBtn"]'); await sleep(200);
      f = await lastSaved(page, 2);
      if (!f || f.w !== r.aw || f.h !== r.ah) fail('끈 상태에서 저장한 PNG가 기존 크기가 아니에요 (' + JSON.stringify(f) + ', 기대 ' + r.aw + '×' + r.ah + ')');
      // 새로고침 뒤에도 꺼짐
      await page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
      await page.evaluate(HOOK);
      s = await item(page);
      if (s.on || s.store !== '0') fail('새로고침 뒤에 끈 선택이 사라졌어요 (' + JSON.stringify(s) + ')');
      await page.click('#qbSave'); await sleep(150);
      if ((await item(page)).checked !== 'false') fail('새로고침 뒤 저장 메뉴의 체크가 꺼짐으로 보이지 않아요');
      const sb = await page.evaluate(() => { const r = document.querySelector('.statusbar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.click(sb.x, sb.y); await sleep(150); // 메뉴 바깥(아래 상태 막대)을 눌러 닫음
      // 키보드: Enter로 열고 ↑(마지막 = 체크 항목) → Enter로 켬, 메뉴는 열린 채, 포커스 그대로 → Esc로 닫힘
      await page.focus('#qbSave'); await press(page, 'Enter'); await press(page, 'ArrowUp');
      if (await page.evaluate(() => document.activeElement.id) !== 'qbUrlItem') fail('키보드로 저장 메뉴의 체크 항목에 갈 수 없어요');
      await press(page, 'Enter');
      s = await item(page);
      if (s.checked !== 'true' || s.store !== '1' || !s.open || await page.evaluate(() => document.activeElement.id) !== 'qbUrlItem') fail('키보드 Enter로 체크 항목을 켜지 못했거나 메뉴·포커스가 바뀌었어요 (' + JSON.stringify(s) + ')');
      await press(page, ' ');
      if ((await item(page)).checked !== 'false') fail('키보드 Space로 체크 항목이 꺼지지 않아요');
      await press(page, ' ');
      await press(page, 'Escape');
      if (!(await page.evaluate(() => document.getElementById('qbSaveMenu').hidden && document.activeElement.id === 'qbSave'))) fail('체크 항목에서 Esc를 누르면 메뉴가 닫히고 저장 버튼으로 돌아가야 해요');
      // 방안뜨기 PNG: 함수 기본값은 띠 없음, 켜면 아래 띠, 위쪽 그림 픽셀은 같음
      await clickId(page, 'filetBtn'); await sleep(400);
      const fr = await page.evaluate(() => new Promise(res => makeFiletImage(async a => {
        const ma = filetLastImage;
        makeFiletImage(async b => {
          const mb = filetLastImage;
          const ia = await createImageBitmap(a), ib = await createImageBitmap(b);
          const draw = im => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x; };
          const xa = draw(ia), xb = draw(ib);
          const da = xa.getImageData(0, 0, ia.width, ia.height).data, db = xb.getImageData(0, 0, ib.width, ia.height).data;
          let diff = 0; for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) diff++;
          res({ a: [ia.width, ia.height], b: [ib.width, ib.height], bandA: ma.band, band: mb.band, diff, bg: [...xb.getImageData(1, ib.height - 2, 1, 1).data].slice(0, 3).join() });
        }, { url: true });
      })));
      if (fr.bandA) fail('makeFiletImage를 옵션 없이 부르면 띠가 없어야 해요');
      if (!fr.band || fr.b[0] !== fr.a[0] || fr.b[1] !== fr.a[1] + fr.band.h || fr.band.h !== Math.max(28, Math.round(fr.a[0] * 0.055))) fail('방안뜨기 PNG에 띠를 켜면 아래로 띠만큼만 늘어야 해요 (' + JSON.stringify(fr) + ')');
      if (fr.diff) fail(`방안뜨기 PNG의 그림 영역이 띠를 켰을 때 달라져요 (${fr.diff}곳)`);
      if (fr.bg !== '226,238,232' || !fr.band || fr.band.url !== 'crochetalpha.com' || fr.band.desc !== '무료 코바늘 도안 만들기') fail('방안뜨기 PNG 띠 색·문구가 달라요 (' + JSON.stringify(fr.band) + ', ' + fr.bg + ')');
      // 방안뜨기 탭의 이미지 저장 버튼도 저장 메뉴의 선택을 따름 (지금 켜짐)
      const n0 = (await page.evaluate(() => window.__saved.length));
      await clickId(page, 'filetSaveImgBtn');
      f = await lastSaved(page, n0 + 1);
      if (!f || f.h !== fr.b[1]) fail('방안뜨기 탭의 이미지 저장이 사이트 주소 선택(켜짐)을 따르지 않아요 (' + JSON.stringify(f) + ')');
      t.errors.forEach(e => fail('한국어: ' + e));
    } finally { await t.close(); }
  }
  // 2) 영어: 라벨·띠 문구, 끄면 영어 페이지도 기존 크기
  {
    const t = await openPage('/en/pattern/');
    try {
      const { page } = t;
      await page.click('#qbSave'); await sleep(150);
      const s = await item(page);
      if (s.label !== 'Add site address to image' || s.checked !== 'true') fail('영어 페이지 체크 항목 문구·기본값이 달라요 (' + s.label + ', ' + s.checked + ')');
      const r = await compare(page);
      if (!r.band || r.band.url !== 'crochetalpha.com' || r.band.desc !== 'free crochet chart maker') fail('영어 페이지 띠 문구가 달라요 (' + JSON.stringify(r.band) + ')');
      if (r.diff || r.bh !== r.ah + r.expectH) fail('영어 페이지에서 띠를 켰을 때 도안 영역이 바뀌거나 높이가 달라요');
      t.errors.forEach(e => fail('영어: ' + e));
    } finally { await t.close(); }
  }
  // 3) 휴대폰·좁은 화면: 메뉴가 화면 안, 체크 항목 글자가 잘리지 않음, 가로 넘침 없음 (한·영 × 라이트·다크)
  for (const p of ['/pattern/', '/en/pattern/']) for (const w of [320, 360, 412]) for (const scheme of ['light', 'dark']) {
    const t = await openPage(p, { width: w, height: 760, mobile: true });
    try {
      const { page } = t;
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]); await sleep(100);
      await page.click('#qbSave'); await sleep(200);
      const m = await page.evaluate(() => {
        const menu = document.getElementById('qbSaveMenu'), r = menu.getBoundingClientRect(), it = document.getElementById('qbUrlItem'), ir = it.getBoundingClientRect(), mt = it.querySelector('.qb-mt');
        return { open: !menu.hidden, inView: r.left >= 0 && r.right <= document.documentElement.clientWidth && ir.bottom <= innerHeight, cut: mt.scrollWidth > mt.clientWidth + 1 || it.scrollWidth > it.clientWidth + 1, h: Math.round(ir.height), over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      const L = p + ' ' + w + 'px ' + (scheme === 'dark' ? '어두운' : '밝은') + ' 화면: ';
      if (!m.open || !m.inView) fail(L + '저장 메뉴(체크 항목 포함)가 화면 밖으로 나가요');
      if (m.cut) fail(L + '"이미지에 사이트 주소 넣기" 글자가 잘려요');
      if (m.h < 44) fail(L + '체크 항목이 손가락으로 누르기에 낮아요 (' + m.h + 'px)');
      if (m.over > 1) fail(L + '가로로 ' + m.over + 'px 넘쳐요');
      await page.tap('#qbUrlItem'); await sleep(150);
      if ((await item(page)).checked !== 'false') fail(L + '체크 항목을 눌러도 꺼지지 않아요');
      views++;
      t.errors.forEach(e => fail(L + e));
    } finally { await t.close(); }
  }
  note('PC 한·영, 방안뜨기, 휴대폰 ' + views + '가지 화면');
}, { limitMin: 4 });

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
    const { title, fn, limitMin } = TESTS[k];
    const reasons = [], notes = [];
    try {
      await Promise.race([
        fn(r => reasons.push(r), n => notes.push(n)),
        sleep(limitMin * 60000).then(() => { throw new Error(limitMin + '분 안에 끝나지 않았어요'); }),
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
