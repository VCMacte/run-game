// Пересобирает список офлайн-кэша в sw.js по тому, что реально лежит на диске.
//
// Вести список руками бессмысленно: забытый файл не ломает разработку — там
// всё берётся из сети, — он ломает установленное приложение, ровно у ребёнка и
// ровно тогда, когда сети нет. А с MediaPipe цена ошибки ещё выше: наполовину
// закэшированная модель даёт молчаливый отказ при старте с невнятной ошибкой.
//
// Номер кэша поднимается тем же запуском: без нового номера установленное
// приложение продолжит отдавать прошлую версию, и правок никто не увидит.
//
// Запуск: node tools/make-sw.mjs [--keep-version]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = join(ROOT, 'sw.js');

// Корень перечислен явно: там же лежит и то, чему в кэше делать нечего —
// serve.js, тесты, README.
const ROOT_FILES = ['./', './index.html', './manifest.webmanifest'];

// Каталоги целиком, с разрешёнными расширениями. js обходится целиком, а не
// перечисляется: новый модуль иначе забудется ровно один раз — и именно тот,
// без которого игра не запустится офлайн.
const DIRS = [
  ['css', ['.css']],
  ['icons', ['.png']],
  ['js', ['.js']],
  // Появится вместе с распознаванием позы: wasm MediaPipe и файл модели.
  // Их нельзя тянуть с CDN — во время игры сети может не быть.
  ['vendor', ['.js', '.wasm', '.task', '.json', '.binarypb']],
  ['assets', ['.webp', '.png', '.svg', '.mp3', '.json']],
];

function walk(rel, exts, out = []) {
  if (!existsSync(join(ROOT, rel))) return out;
  for (const name of readdirSync(join(ROOT, rel)).sort()) {
    const sub = posix.join(rel, name);
    if (statSync(join(ROOT, sub)).isDirectory()) { walk(sub, exts, out); continue; }
    if (exts.some((e) => name.endsWith(e))) out.push('./' + sub);
  }
  return out;
}

const assets = [...ROOT_FILES];
for (const [dir, exts] of DIRS) walk(dir, exts, assets);

let src = readFileSync(SW, 'utf8');

if (!process.argv.includes('--keep-version')) {
  src = src.replace(/const CACHE = 'run-v(\d+)';/, (_, v) => `const CACHE = 'run-v${Number(v) + 1}';`);
}

src = src.replace(/const ASSETS = \[[\s\S]*?\n\];/,
  'const ASSETS = [\n' + assets.map((a) => `  '${a}',`).join('\n') + '\n];');

writeFileSync(SW, src, 'utf8');

const version = src.match(/const CACHE = '([^']+)'/)[1];
console.log(`${version}: ${assets.length} файлов в офлайн-кэше`);
