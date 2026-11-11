// 내 컴퓨터에서 사이트를 미리 보는 작은 서버 (설치할 것 없음, Node만 있으면 됨)
// 사용: node .preview/serve.js [열 주소]   예) node .preview/serve.js /pattern/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 5173;
// 열 주소: "pattern", "/pattern/" 모두 가능. Git Bash가 "/pattern/"을 "C:/Program Files/Git/pattern/"처럼
// 폴더 경로로 바꿔 넘기는 경우도 있어서, 앞쪽 드라이브·폴더 부분은 떼어냄
let START = (process.argv[2] || 'pattern').replace(/\\/g, '/').replace(/^[A-Za-z]:\/Program Files\/Git/i, '');
START = '/' + START.replace(/^\/+|\/+$/g, '') + '/';
if(START === '//') START = '/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

function openBrowser(){
  const url = 'http://localhost:' + PORT + START;
  const cmd = process.platform === 'win32' ? 'start "" "' + url + '"' : process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
  exec(cmd);
  console.log('열었어요: ' + url);
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, p);
  if(!file.startsWith(ROOT)){ res.writeHead(403); return res.end(); }
  if(fs.existsSync(file) && fs.statSync(file).isDirectory()){
    if(!p.endsWith('/')){ res.writeHead(301, { Location: p + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  fs.readFile(file, (err, data) => {
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(ROOT, '404.html')).on('error', () => res.end('404')).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.on('error', e => {
  // 이미 켜져 있으면 브라우저만 열기
  if(e.code === 'EADDRINUSE'){ openBrowser(); setTimeout(() => process.exit(0), 500); }
  else { console.error(e); process.exit(1); }
});
server.listen(PORT, () => {
  console.log('미리보기 서버가 켜졌어요. 이 창을 닫으면 꺼져요.');
  openBrowser();
});
