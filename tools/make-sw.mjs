// Пересобирает список офлайн-кэша в sw.js по тому, что реально лежит на диске,
// и поднимает номер версии.
//
// Вести список руками бессмысленно: забытый файл не ломает разработку — там
// всё берётся из сети, — он ломает установленное приложение, ровно у ребёнка и
// ровно тогда, когда сети нет.
//
// Номер версии поднимается тем же запуском: без нового номера установленное
// приложение продолжит отдавать прошлую сборку, и правок никто не увидит.
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
  // MediaPipe: wasm, модель и сам пакет. Его нельзя тянуть с CDN — во время
  // игры сети может не быть. Расширение .mjs тут не для красоты: пакет
  // поставляется именно так, и без него на телефоне без сети не загрузится
  // вообще ничего, а список кэша при этом выглядит полным.
  ['vendor', ['.js', '.mjs', '.wasm', '.task', '.json', '.binarypb']],
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

const src = readFileSync(SW, 'utf8');
const current = src.match(/const CACHE = 'run-v(\d+)';/);
if (!current) throw new Error('в sw.js не нашёлся номер версии вида run-vN');

const version = process.argv.includes('--keep-version')
  ? `run-v${current[1]}`
  : `run-v${Number(current[1]) + 1}`;

/* Модуль с версией пишется ДО обхода каталогов, и порядок здесь существенный:
   иначе js/version.js попадёт в список кэша только со следующего запуска — то
   есть ровно тот файл, который сообщает версию, будет в офлайне отставать на
   версию.

   Номер один на двоих — на кэш и на экран. Два источника разошлись бы, и
   строка на экране начала бы врать именно тогда, когда по ней пытаешься
   понять, доехала ли сборка до телефона. */
writeFileSync(join(ROOT, 'js/version.js'), [
  '// Генерируется tools/make-sw.mjs вместе с номером кэша. Руками не править.',
  `export const VERSION = '${version}';`,
  `export const BUILT_AT = '${new Date().toISOString().slice(0, 16).replace('T', ' ')}';`,
  '',
].join('\n'), 'utf8');

const assets = [...ROOT_FILES];
for (const [dir, exts] of DIRS) walk(dir, exts, assets);

const out = src
  .replace(/const CACHE = '[^']+';/, `const CACHE = '${version}';`)
  .replace(/const ASSETS = \[[\s\S]*?\n\];/,
    'const ASSETS = [\n' + assets.map((a) => `  '${a}',`).join('\n') + '\n];');

writeFileSync(SW, out, 'utf8');
console.log(`${version}: ${assets.length} файлов в офлайн-кэше`);
