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
      const shareShown = await page.evaluate(() => !document.getElementById('shareImgBtn').hidden && document.getElementById('shareImgBtn').offsetWidth > 0);
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
        const b = document.getElementById('shareImgBtn'), r = b.getBoundingClientRect();
        const bar = document.querySelector('.appbar');
        const out = [...bar.querySelectorAll('button, a, summary')].filter(e => { const q = e.getBoundingClientRect(); return q.width > 0 && (q.right > window.innerWidth + 1 || q.left < -1); }).map(e => e.id || e.textContent.trim());
        return { coarse: matchMedia('(pointer: coarse)').matches, shown: !b.hidden && r.width > 0, label: b.getAttribute('aria-label'), out, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      });
      if (!st.coarse) { note(`${p}: 이 브라우저는 터치 흉내가 안 돼서 휴대폰 확인은 건너뜀`); continue; }
      coarseSeen = true;
      if (!st.shown) { fail(`${p}: 터치 기기(파일 공유 가능)인데 공유 버튼이 보이지 않아요`); continue; }
      const expectLabel = p.startsWith('/en/') ? 'Share' : '공유';
      if (st.label !== expectLabel) fail(`${p}: 공유 버튼 이름이 "${expectLabel}"가 아니라 "${st.label}"이에요`);
      if (st.out.length || st.wide) fail(`${p}: ${w}px 폭에서 맨 위 막대가 화면 밖으로 넘쳐요 (${st.out.join(', ') || '가로 스크롤'})`);
      await page.click('#shareImgBtn');
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
          editOff: ['toolPaintBtn', 'undoBtn', 'clearGridBtn', 'rot90Btn'].every(id => !vis(id)) && !document.querySelector('.inspector').getClientRects().length,
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
          const w = c.width, h = c.height, at = (a, b) => [...x.getImageData(a, b, 1, 1).data].slice(0, 3);
          const darkIn = (y0, hh) => { const d = x.getImageData(0, y0, w, hh).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) n++; return n; };
          return { w, h, corners: [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)], darkTop: darkIn(0, Math.min(h, 170)), darkBottom: darkIn(Math.max(0, h - 150), Math.min(h, 150)), meta: filetLastImage };
        }, buf.toString('base64'));
        if (!png.corners.every(c => c.join() === '255,255,255')) fail(`저장한 이미지의 바탕이 흰색이 아니에요 (네 모서리 ${JSON.stringify(png.corners)})`);
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
      if (await page.evaluate(() => !document.getElementById('toolPaintBtn').getClientRects().length)) fail('도안 탭으로 돌아왔는데 편집 도구가 다시 보이지 않아요');
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
      if (await vis(page, '.ribbon') || await vis(page, '#gridCanvas')) fail('시작 화면인데 작업창이나 격자가 함께 보여요');
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
      const g = await page.evaluate(() => ({ w: document.getElementById('gridCanvas').getBoundingClientRect().width, empty: !gridData.some(Boolean), rows, cols, ribbon: document.querySelector('.ribbon').getClientRects().length > 0 }));
      const back = await shown(['saveFileBtn', 'undoBtn', 'redoBtn', 'saveImgBtn']);
      if (!back.every(Boolean)) fail(`시작 화면을 닫았는데 저장·되돌리기·다시하기·이미지 저장이 다시 보이지 않아요 (${back.join(',')})`);
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
      if (!(await t.page.evaluate(() => document.getElementById('saveImgBtn').getClientRects().length > 0))) fail('360px: 시작 화면을 닫았는데 이미지 저장(내려받기) 버튼이 다시 보이지 않아요');
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
    const row = document.getElementById('recentRow');
    return { chips: [...document.querySelectorAll('#recentChips .recent-chip')].map(b => b.dataset.color), shown: !row.hidden && row.getClientRects().length > 0,
      active: activeColor, sel: [...document.querySelectorAll('#recentChips .recent-chip.selected')].map(b => b.dataset.color),
      store: (() => { try { return localStorage.getItem('crochet-recent-colors'); } catch (e) { return null; } })(), label: document.querySelector('.recent-label').textContent,
      names: [...document.querySelectorAll('#recentChips .recent-chip')].map(b => b.getAttribute('aria-label')) };
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
      await page.click('#recentChips .recent-chip[data-color="' + COLORS[1] + '"]'); await sleep(150);
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
      await page.evaluate(c => { const sw = [...document.querySelectorAll('#palette .swatch')].find(s => getComputedStyle(s).backgroundColor === c); sw.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }, hexToRgb(COLORS[6]));
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
  // 4) 휴대폰 폭 (작업창을 펼친 상태, 어두운 화면)
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
      await page.evaluate(() => setRibbonFolded(false)); await sleep(300);
      // 팔레트가 아주 길면(색 9개 이상) 휴대폰 320px에서는 팔레트 자체가 넘치므로, 여기서는 색 6개로 "최근" 줄만 확인
      await page.evaluate(cs => { PRESET_COLORS.length = 0; cs.slice(0, 6).forEach(c => PRESET_COLORS.push(c)); activeColor = PRESET_COLORS[0]; buildPalette(); }, COLORS);
      await pick(page, 1, 2, 3, 4);
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth, row = document.getElementById('recentRow'), rr = row.getBoundingClientRect();
        const chips = [...document.querySelectorAll('#recentChips .recent-chip')].map(b => b.getBoundingClientRect());
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
