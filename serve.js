// Локальный статический сервер для проверки перед публикацией.
// localhost — защищённый контекст, поэтому микрофон и PWA работают.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8099;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  // Для MediaPipe: загрузчик проверяет тип wasm, а модель отдаётся как поток байт.
  '.wasm': 'application/wasm', '.task': 'application/octet-stream',
};

// Приёмник файлов из браузера. Нужен потому, что на машине нет растеризатора
// SVG, а единственный доступный — сам браузер; записать файл сам он не может.
// Только для локальной разработки: путь ограничен каталогом проекта.
function saveFromBrowser(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 64e6) req.destroy(); });
  req.on('end', () => {
    try {
      // dataUrl — для картинок из браузера, text — для замеров и дампов скелета.
      const { path: rel, dataUrl, text } = JSON.parse(body);
      const target = path.resolve(ROOT, rel);
      if (!target.startsWith(ROOT)) throw new Error('путь вне проекта');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Перезапись поверх существующего файла на Windows иногда падает
      // с UNKNOWN: его успевает подхватить индексатор или антивирус.
      // Удалить и создать заново надёжнее, чем писать в занятый дескриптор.
      fs.rmSync(target, { force: true });
      fs.writeFileSync(target, typeof text === 'string'
        ? Buffer.from(text, 'utf8')
        : Buffer.from(dataUrl.split(',')[1], 'base64'));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, bytes: fs.statSync(target).size }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(e.message) }));
    }
  });
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/save')) return saveFromBrowser(req, res);

  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
