// Проверки оболочки: манифест, связность разметки и кода, полнота офлайн-кэша.
//
//   node tests-shell.mjs
//
// Тестов на игровой движок здесь нет и не будет — он проверяется прогоном в
// браузере. А вот три вещи ниже в браузере как раз не видны, потому что ломают
// не разработку, а установленное приложение у ребёнка и без сети:
//
//   * забытый в ASSETS файл — игра не запустится офлайн, и причина не всплывёт
//     ни в одной вкладке с живой сетью;
//   * опечатка в id — обработчик молча не навесится, кнопка просто не нажмётся;
//   * неверные display/orientation в манифесте — Chrome запекает их в WebAPK
//     при установке, и поздняя правка ждёт обновления WebAPK сутками.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failed = 0;
let passed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failed++;
  console.error(`  ПРОВАЛ  ${name}${detail ? '\n          ' + detail : ''}`);
}
function group(name, fn) {
  console.log(name);
  return fn(); // часть проверок асинхронна — вызывающий их дожидается
}

const html = read('index.html');

// ───────────────────────────── манифест ─────────────────────────────

group('манифест', () => {
  const m = JSON.parse(read('manifest.webmanifest'));

  // Эти два поля Chrome запекает в WebAPK при установке. Менять их потом
  // означает переустановку, поэтому они проверяются, а не подразумеваются.
  check('display = fullscreen', m.display === 'fullscreen', `сейчас ${m.display}`);
  check('orientation = landscape', m.orientation === 'landscape', `сейчас ${m.orientation}`);
  check('есть display_override', Array.isArray(m.display_override) && m.display_override[0] === 'fullscreen');
  check('манифест подключён в разметке', html.includes('rel="manifest"'));

  const sizeOf = (file) => {
    const b = readFileSync(join(ROOT, file));
    check(`${file} — настоящий PNG`, b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  };
  for (const icon of m.icons) {
    check(`иконка ${icon.src} существует`, existsSync(join(ROOT, icon.src)));
    if (!existsSync(join(ROOT, icon.src))) continue;
    check(`размер ${icon.src} совпадает с заявленным`, sizeOf(icon.src) === icon.sizes,
      `заявлено ${icon.sizes}, в файле ${sizeOf(icon.src)}`);
  }
  check('есть maskable-иконка', m.icons.some((i) => i.purpose === 'maskable'));
});

// ────────────────── разметка и код ссылаются друг на друга ──────────────────

function jsFiles(rel = 'js', out = []) {
  for (const name of readdirSync(join(ROOT, rel)).sort()) {
    const sub = posix.join(rel, name);
    if (statSync(join(ROOT, sub)).isDirectory()) jsFiles(sub, out);
    else if (name.endsWith('.js')) out.push(sub);
  }
  return out;
}

group('разметка и код', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  for (const file of jsFiles()) {
    const src = read(file);

    // Каждый id, который код ищет в документе, обязан в документе быть.
    for (const m of src.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)) {
      const id = m[1] || m[2];
      check(`${file}: в разметке есть #${id}`, ids.has(id));
    }

    // Каждый импорт обязан разрешаться в существующий файл: сборщика нет,
    // и опечатку в пути никто, кроме браузера, не поймает.
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
      const target = posix.normalize(posix.join(posix.dirname(file), m[1]));
      check(`${file}: импорт ${m[1]} разрешается`, existsSync(join(ROOT, target)));
    }
  }

  // Модуль подключён как module — иначе import не заработает вовсе.
  check('точка входа подключена как module', /<script type="module" src="js\/app\.js">/.test(html));
});

// ───────────────────────────── офлайн-кэш ─────────────────────────────

group('офлайн-кэш', () => {
  const sw = read('sw.js');
  const listed = [...sw.matchAll(/^\s*'(\.\/[^']*)',$/gm)].map((m) => m[1]);
  check('список кэша не пуст', listed.length > 0);

  for (const p of listed) {
    if (p === './') continue;
    check(`в кэше указан существующий файл ${p}`, existsSync(join(ROOT, p.slice(2))));
  }

  // Обратная сторона, ради которой тест и написан: файл есть на диске,
  // приложению нужен, а в кэш не попал.
  const required = [
    ...jsFiles().map((f) => './' + f),
    './css/style.css',
    './index.html',
    './manifest.webmanifest',
  ];
  for (const p of required) {
    check(`${p} попал в офлайн-кэш`, listed.includes(p),
      'забыли пересобрать: node tools/make-sw.mjs');
  }

  check('версия кэша задана', /const CACHE = 'run-v\d+';/.test(sw));
});

// ───────────────────────────── настройки ─────────────────────────────

await group('настройки', async () => {
  const { settings, OPTIONS } = await import('./js/settings.js');

  // Умолчание обязано быть одним из предложенных вариантов, иначе подпись в
  // родительском меню покажет сырое значение вместо слова.
  for (const name of Object.keys(OPTIONS)) {
    check(`умолчание ${name} есть в списке вариантов`,
      OPTIONS[name].some((o) => o.value === settings.get(name)),
      `сейчас ${JSON.stringify(settings.get(name))}`);
  }

  // Приседания — половина управления. Выключенными по умолчанию они уже были,
  // когда умолчание выводилось из порядка вариантов.
  check('приседания включены по умолчанию', settings.get('crouch') === true);

  // Перебор по кругу возвращается в исходную точку.
  const before = settings.get('speed');
  for (let i = 0; i < OPTIONS.speed.length; i++) settings.cycle('speed');
  check('перебор вариантов замкнут', settings.get('speed') === before);
});

// ───────────────────────────── итог ─────────────────────────────

if (failed) {
  console.error(`\n${failed} провал(ов) из ${passed + failed} проверок`);
  process.exit(1);
}
// Число проверок печатается намеренно: «всё сошлось» при нуле проверок
// выглядит точно так же, как при полусотне.
console.log(`\nвсё сошлось: ${passed} проверок`);
