/* 本地预览：先 node tools/build-www.js，再 node tools/serve.js，打开 http://localhost:5173 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'app');
const PORT = Number(process.env.PORT || 5173);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  // 防目录穿越
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      const hint = p === '/index.html' ? 'run: node tools/build-www.js' : 'not found';
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(hint);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, () => console.log('http://localhost:' + PORT));
