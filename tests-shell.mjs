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

  // "any" здесь обязательно, и это не недосмотр: манифест запекается в WebAPK
  // при установке, и жёсткий landscape сделал бы портретное меню недоступным.
  // Ориентацию задаёт show() поэкранно.
  check('orientation = any', m.orientation === 'any',
    `сейчас ${m.orientation}; поэкранную блокировку делает js/app.js`);
  check('ориентация задаётся поэкранно', /lockOrientation\(/.test(read('js/app.js')));
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
    //
    // Динамические import() проверяются отдельным выражением, и это не
    // педантизм: ими подключается всё, что грузится по требованию —
    // синтетический источник поз, тренировка, сам MediaPipe. Статическая
    // проверка их не видит, а ошибка в таком пути всплывёт только в момент
    // нажатия кнопки, на телефоне.
    const statics = [...src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)];
    const dynamics = [...src.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)];
    for (const m of [...statics, ...dynamics]) {
      const target = posix.normalize(posix.join(posix.dirname(file), m[1]));
      check(`${file}: импорт ${m[1]} разрешается`, existsSync(join(ROOT, target)));
    }
  }

  // Модуль подключён как module — иначе import не заработает вовсе.
  check('точка входа подключена как module', /<script type="module" src="js\/app\.js">/.test(html));
});

// ───────────────────────────── экран результата ─────────────────────────────

/* Сторожа на два места в js/train.js, которые нельзя проверить изнутри.

   train.js в node не импортируется: он тянет DOM, канвас и источник поз.
   Проверка поэтому текстовая, как и соседние в группе «разметка и код». Грубая
   — но она стоит здесь не вместо прогона в браузере, а вместо его отсутствия:
   оба дефекта ниже уже случились, и оба выглядели не как дефект.

   1. `result` обязан уходить из hud() ВСЕГДА. Пока он передавался одним
      вызовом из finish(), любой следующий hud() — с автопаузы, с отсчёта, со
      смены камеры, с возврата из родительского меню — приходил без этого
      поля, и app.js рисовал `result?.stars ?? 0`, то есть «0 колец собрано /
      0 раз задел». В журнале 6 октября это видно прямо: `run.finish
      stars:102`, а через 3.8 секунды `pause why:"scale"`. Заказчик описал это
      как «через несколько секунд все данные результата обнулились» — и был
      прав в наблюдении, хотя никакого обнуления не происходило.

   2. На стадии `result` присутствие судить нельзя. Забег кончился, ребёнок
      отходит от камеры — и onFree честно объявлял автопаузу «Отойди немного
      назад» поверх цифр результата, на экране, где отходить ровно и надо. */
group('экран результата', () => {
  const train = read('js/train.js');

  const hudBody = train.match(/function hud\(extra = \{\}\) \{[\s\S]*?\n  \}/);
  check('hud() найден в train.js', !!hudBody,
    'если функция переименована — переписать и этого сторожа, а не удалить');
  check('result уходит из hud() всегда', /\bresult,/.test(hudBody?.[0] || ''),
    'без этого экран результата обнулится на первой же автопаузе');

  check('на стадии result присутствие не судится',
    /stage === 'result'\) return/.test(train),
    'иначе поверх цифр появится «Отойди немного назад»');

  // И то же самое с другой стороны: app.js обязан брать result из HUD, а не
  // из собственной памяти — иначе сторож выше охраняет пустоту.
  check('app.js читает result из полезной нагрузки HUD',
    /result,[\s\S]{0,400}\} = h;/.test(read('js/app.js')),
    'result разбирается из объекта HUD вместе с остальными полями');

  const app = read('js/app.js');

  /* Список рекордов обязан быть ограничен в коде.

     Прокрутки в приложении нет нигде (`html, body` с `overflow: hidden`), а
     экран `.sheet` центрирует колонку по вертикали — то есть список длиннее
     экрана уезжает за ОБА края сразу, унося и заголовок, и кнопку «Назад».
     Вернуться после этого нечем. Хранится до 50 записей на игрока на длину,
     так что без ограничения это вопрос времени, а не возможности. */
  check('таблица рекордов режется, а не печатается целиком',
    /RECORDS_SHOWN/.test(app) && /\.slice\(0, RECORDS_SHOWN\)/.test(app),
    'renderRecords выводит все строки — экран рекордов станет невыходимым');
  check('у списков есть и второй рубеж в стилях',
    /#recList, #playerList \{[^}]*overflow-y: auto/.test(read('css/style.css')),
    'ограничения только в коде мало: список игроков числом не ограничен');

  /* Отказ хранилища не имеет права выглядеть успехом. Забег уже не повторить,
     и «Записано ✓» над записью, которой нет, — тихая потеря ровно того, ради
     чего экран существует. В node это не проверить: localStorage там нет
     вовсе, а переполнение — свойство работающего браузера. */
  check('запись считается удавшейся только по ответу хранилища',
    /const written = players\.addRecord/.test(app) && /if \(!written\)/.test(app),
    'recorded выставляется без проверки — отказ хранилища станет невидимым');
  check('откат при отказе: запись не остаётся в памяти',
    /if \(!persist\(\)\) \{/.test(read('js/players.js')),
    'иначе таблица покажет строку, которой после перезагрузки не будет');

  /* Запись в таблицу рекордов идёт только с финиша. Выход через паузу её не
     делает — не фильтром, а отсутствием вызова: половина забега без начала
     результатом не является. Сторож держит именно это свойство. */
  const toMenu = app.match(/\$\('runToMenu'\)\.onclick[\s\S]*?\n\};/);
  check('выход через паузу найден', !!toMenu);
  check('выход через паузу ничего не записывает',
    !/addRecord|saveRecord/.test(toMenu?.[0] || ''),
    'прерванный забег не результат');
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

  // Номер версии живёт в двух местах — в кэше и в модуле для экрана, — и
  // пишутся они одним запуском. Если разойдутся, строка внизу экрана начнёт
  // врать именно тогда, когда по ней пытаешься понять, доехала ли сборка до
  // телефона.
  const ver = read('js/version.js');
  const inSw = sw.match(/const CACHE = '([^']+)';/)[1];
  const inJs = ver.match(/VERSION = '([^']+)'/)?.[1];
  check('версия в js/version.js совпадает с кэшем', inJs === inSw,
    `в кэше ${inSw}, в модуле ${inJs}`);
  check('js/version.js попал в офлайн-кэш', listed.includes('./js/version.js'),
    'иначе файл, который сообщает версию, в офлайне отстаёт на версию');
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

  /* Экран телефона в забеге. Умолчание обязано совпадать с тем, как игра
     ведёт себя сегодня: wake lock держится, экран не гаснет. Это не
     перестраховка — если умолчание уедет в «может гаснуть» незамеченным,
     ребёнок посреди забега рискует получить замерший телевизор, а взрослый не
     будет знать, что это он включил.

     Сама настройка появилась под замер: по журналу 7 октября кадр шёл 38 fps
     с горящей панелью и 46–50 с погасшей, при неизменных частоте поз и
     инференсе. То есть собственная панель телефона стоит столько же, сколько
     весь арт, — и это надо проверить на устройстве, а не досчитать. */
  check('экран в забеге по умолчанию не гаснет', settings.get('screenRun') === 'awake');
  check('у настройки ровно два варианта', OPTIONS.screenRun.length === 2,
    JSON.stringify(OPTIONS.screenRun));

  // Перебор по кругу возвращается в исходную точку.
  const before = settings.get('speed');
  for (let i = 0; i < OPTIONS.speed.length; i++) settings.cycle('speed');
  check('перебор вариантов замкнут', settings.get('speed') === before);
});

// ───────────────────────────── MediaPipe ─────────────────────────────

await group('MediaPipe', async () => {
  const { VENDOR } = await import('./js/config.js');
  const sw = read('sw.js');
  const listed = new Set([...sw.matchAll(/^\s*'(\.\/[^']*)',$/gm)].map((m) => m[1]));

  for (const [path, bytes] of Object.entries(VENDOR.files)) {
    const file = join(ROOT, path.slice(2));
    check(`${path} на месте`, existsSync(file));
    if (!existsSync(file)) continue;

    // Размер сверяется, потому что по нему на телефоне определяется
    // целостность офлайн-кэша. Разошёлся с файлом — проверка станет врать.
    check(`${path}: размер совпадает с объявленным`, statSync(file).size === bytes,
      `в config.js ${bytes}, на диске ${statSync(file).size}`);

    // Вот ради чего эта группа: vision_bundle.mjs однажды уже не попал в
    // кэш, потому что генератор не знал расширение .mjs. На разработке это
    // незаметно — там всё берётся из сети.
    check(`${path} попал в офлайн-кэш`, listed.has(path),
      'забыли пересобрать или генератор не знает расширение');
  }

  // Пути к MediaPipe абсолютные: относительные указывали бы из воркера в
  // js/vendor/..., и всплыло бы это только на телефоне.
  for (const [name, url] of Object.entries({ wasmBase: VENDOR.wasmBase, bundle: VENDOR.bundle, model: VENDOR.model })) {
    check(`${name} — абсолютный URL`, /^[a-z]+:\/\//.test(url), `сейчас «${url}»`);
    check(`${name} указывает внутрь vendor/`, url.includes('/vendor/'));
  }
  check('каталог wasm существует', existsSync(join(ROOT, 'vendor/mediapipe/wasm')));

  // Вариант без SIMD мы намеренно не кладём, зато обязаны проверять поддержку
  // до запуска — иначе загрузчик уйдёт за несуществующим файлом.
  check('поддержка SIMD проверяется перед запуском',
    /isSimdSupported/.test(read('js/vendor.js')));
});

// ───────────────────────────── текст ─────────────────────────────

await group('текст', async () => {
  const { plural, count, SESSIONS, STARS, TIMES } = await import('./js/text.js');
  const forms = ['сессия', 'сессии', 'сессий'];

  // Проверяются именно те числа, на которых правило ломается: 11–14 берут
  // последнюю форму вопреки последней цифре, 21 — первую.
  const expected = {
    0: 'сессий', 1: 'сессия', 2: 'сессии', 4: 'сессии', 5: 'сессий',
    11: 'сессий', 12: 'сессий', 14: 'сессий', 21: 'сессия', 22: 'сессии',
    25: 'сессий', 101: 'сессия', 111: 'сессий',
  };
  for (const [n, want] of Object.entries(expected)) {
    check(`${n} → ${want}`, plural(Number(n), forms) === want,
      `получилось «${plural(Number(n), forms)}»`);
  }
  check('count склеивает число и форму', count(3, SESSIONS) === '3 сессии');

  // Экран результата читает ребёнок, и «4 звёзд собрано» там особенно
  // заметно: это первое, на что он смотрит после финиша.
  check('1 звезда', plural(1, STARS) === 'звезда');
  check('4 звезды', plural(4, STARS) === 'звезды');
  check('5 звёзд', plural(5, STARS) === 'звёзд');
  check('21 звезда', plural(21, STARS) === 'звезда');
  check('11 звёзд', plural(11, STARS) === 'звёзд');
  check('1 раз', plural(1, TIMES) === 'раз');
  check('2 раза', plural(2, TIMES) === 'раза');
  check('5 раз', plural(5, TIMES) === 'раз');
});

/* ──────────────────────── калибровка на экране ────────────────────────

   Арифметику цели проверяет tests-control.mjs, а здесь — проводка до экрана:
   train.js и app.js тянут DOM и в node не импортируются. Сторожа текстовые, и
   если место правки переписано — переписать надо и сторожа, а не удалить его.
   Без этой проводки цель считается, но ребёнок её не видит, а экран снова
   молчит о том, чего от него хотят. */
group('калибровка на экране', () => {
  const train = read('js/train.js');
  const app = read('js/app.js');

  check('цель доезжает до окошка камеры', /drawSkeleton\(skeleton, lastLm, lastOk,/.test(train),
    'без четвёртого аргумента зона не рисуется вовсе');
  check('и только на калибровке', /stage === 'calibrate' \? lastTarget : null/.test(train),
    'в забеге зона поверх предпросмотра — это шум');
  check('цель запоминается из автомата', /lastTarget = r\.target/.test(train));
  check('провал в журнале назван по провалившейся стадии',
    /calib\.fail', \{ stage: r\.failed\.id \}/.test(train),
    'в r.stage к этому моменту уже следующая стадия');

  check('взрослому на калибровке говорят, что делать', /calib\?\.adult/.test(app),
    'ребёнку — зона и команда, взрослому — строка: это разные адресаты');
  check('силуэт показывается только на стадии «встань»',
    /target\?\.kind === 'stand'/.test(app),
    'иначе рамка в середине спорит с зоной, которая зовёт в сторону');
});

// ───────────────────────────── журнал ─────────────────────────────

await group('журнал', async () => {
  const { LIMITS } = await import('./js/log.js');

  check('потолок объёма — 25 МБ', LIMITS.bytes === 25 * 1024 * 1024,
    `сейчас ${LIMITS.bytes} байт`);
  check('потолок — 20 сессий', LIMITS.sessions === 20, `сейчас ${LIMITS.sessions}`);
  check('сброс на диск чаще, чем раз в 5 секунд', LIMITS.flushMs <= 5000,
    'иначе теряются записи прямо перед падением — ровно те, ради которых всё это');

  /* Склейка повторов. Понадобилась после журнала 6 октября: одна ошибка в
     кадре дала 1478 одинаковых записей и 313 КБ за 133 секунды, а потолки
     `trim` работают целыми сессиями — то есть один дефект вытесняет из журнала
     свидетельства всех прошлых забегов. */
  const { sameEvent } = await import('./js/log.js');
  check('потолок склейки задан и не бесконечен',
    Number.isFinite(LIMITS.repeat) && LIMITS.repeat > 1,
    `сейчас ${LIMITS.repeat}`);
  const err = (msg, line) => ({ t: 1, type: 'error', message: msg, source: 'js/train.js', line });
  check('одинаковые ошибки склеиваются', sameEvent(err('a', 216), err('a', 216)));
  check('время и счётчик склейке не мешают',
    sameEvent({ ...err('a', 216), _n: 7, _lastT: 99 }, err('a', 216)),
    'иначе склеится только вторая запись, а дальше снова по одной');
  /* `n` — ПОЛЕЗНАЯ нагрузка (`skeleton`, `samples`, `countdown` считают им
     отсчёты и секунды), и счётчик повторов не имеет права её затирать. */
  check('события, различающиеся полем n, НЕ склеиваются',
    !sameEvent({ t: 1, type: 'countdown', n: 3 }, { t: 2, type: 'countdown', n: 4 }),
    'иначе второй отсчёт исчез бы, а у первого молча вырос счётчик');
  check('разные строки НЕ склеиваются', !sameEvent(err('a', 216), err('a', 300)),
    'склеить две разные ошибки — значит потерять вторую насовсем');
  check('разные сообщения НЕ склеиваются', !sameEvent(err('a', 216), err('b', 216)));
  check('разные типы НЕ склеиваются', !sameEvent(err('a', 216), { t: 1, type: 'pause' }));
  check('вложенные поля сравниваются',
    !sameEvent({ t: 1, type: 'samples', rows: [[1, 2]] }, { t: 1, type: 'samples', rows: [[1, 3]] }));

  // И со стороны вызова: предикат может быть верным, а место вызова — пропасть.
  const logSrc = read('js/log.js');
  check('event() действительно считает повторы', /prev\._n = \(prev\._n \|\| 1\) \+ 1/.test(logSrc),
    'если склейка переписана — переписать и этого сторожа, а не удалить');
  check('время первого события при склейке не меняется',
    !/prev\.t =/.test(logSrc), 'по нему видно, когда поток начался');

  // Папка для журналов лежит в репозитории, а сами журналы — нет: репозиторий
  // публичный, а это записи о ребёнке.
  check('папка logs/ существует', existsSync(join(ROOT, 'logs')));
  check('в logs/ есть README', existsSync(join(ROOT, 'logs/README.md')));
  const ignore = read('.gitignore');
  check('журналы не попадают в репозиторий', /^logs\/\*$/m.test(ignore));
  check('README журналов остаётся в репозитории', /^!logs\/README\.md$/m.test(ignore));
});

// ───────────────────────────── итог ─────────────────────────────

if (failed) {
  console.error(`\n${failed} провал(ов) из ${passed + failed} проверок`);
  process.exit(1);
}
// Число проверок печатается намеренно: «всё сошлось» при нуле проверок
// выглядит точно так же, как при полусотне.
console.log(`\nвсё сошлось: ${passed} проверок`);
