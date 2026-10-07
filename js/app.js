// Оболочка приложения: запуск, полный экран, размеры, экраны, меню.
// Игровой логики здесь нет — она придёт отдельными модулями (js/game.js и
// соседи), а этот файл отвечает за то, чтобы приложение вообще жило на
// телефоне, стоящем на штативе, и доезжало до телевизора в приличном виде.

import { settings, OPTIONS } from './settings.js';
import { players } from './players.js';
import { clear as clearCalibration } from './calibrate.js';
import * as log from './log.js';
import { count, plural, SESSIONS, EVENTS, STARS, TIMES, RUNS } from './text.js';
import { withTimeout, isDev, flag } from './util.js';
import { FINISH } from './config.js';
import { VERSION, BUILT_AT } from './version.js';

const $ = (id) => document.getElementById(id);

/* Имя игрока попадает в разметку через innerHTML — значит его надо обезвредить.

   Имя вводит взрослый на своём телефоне, так что злого умысла здесь не бывает;
   опасен не умысел, а случай. Ребёнок, тыкающий в клавиатуру, однажды наберёт
   угловую скобку, и вся таблица рекордов перестанет рисоваться — без ошибки,
   просто пустой экран, потому что разметка окажется сломанной. */
const safeText = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// ─────────────────────────── общие приёмы ───────────────────────────

/* Установленное приложение против вкладки браузера. Разница не косметическая:
   во вкладке на телевизор уезжают адресная строка и системные кнопки. */
const installedApp = matchMedia('(display-mode: fullscreen)').matches
  || matchMedia('(display-mode: standalone)').matches
  || navigator.standalone === true;

// ─────────────────────────── размеры кадра ───────────────────────────

/* Полный экран здесь — косметика, а не несущая конструкция. Размер берём от
   реально доступной области, а не от 100vh: вылезла строка состояния —
   приложение стало на несколько процентов меньше и продолжает работать.
   Единица --u задаётся по меньшей стороне доступной области, чтобы вся вёрстка
   масштабировалась одним числом. */
function layout() {
  const vv = window.visualViewport;
  const w = vv ? vv.width : innerWidth;
  const h = vv ? vv.height : innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--vh', `${h}px`);
  root.setProperty('--u', `${Math.min(w, h) / 100}px`);
}
/* Канвас скелета живёт поверх видео и обязан совпадать с ним по размеру.
   Размер считается от разметки, а не от камеры: кадр камеры может быть
   каким угодно, а окошко всегда 16:9. */
function sizeSkeleton() {
  const box = $('runPreview');
  const cv = $('runSkeleton');
  if (!box || !cv) return;
  const r = box.getBoundingClientRect();
  if (!r.width) return;
  cv.width = Math.round(r.width);
  cv.height = Math.round(r.height);
}

layout();
sizeSkeleton();
addEventListener('resize', () => { layout(); sizeSkeleton(); });
addEventListener('orientationchange', layout);
window.visualViewport?.addEventListener('resize', layout);

// ───────────────────── полный экран и бодрый экран ─────────────────────

/* Ориентация задаётся поэкранно, а не манифестом. В манифесте стоит "any",
   и это не недосмотр: Chrome запекает манифест в WebAPK при установке, и
   жёсткий landscape сделал бы портрет недоступным вообще — а меню держат в
   руке, его место вертикальное. Горизонталь нужна только забегу, который
   уходит на телевизор. */
function lockOrientation(kind) {
  return withTimeout(screen.orientation?.lock?.(kind) ?? Promise.resolve(), 1500);
}

async function requestFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  await withTimeout(el.requestFullscreen({ navigationUI: 'hide' }), 3000);
}

/* Ребёнок телефон не трогает, поэтому приём комикса «вернуть полный экран
   первым же касанием» здесь сам по себе не сработает. Пробуем вернуть его на
   каждом удобном событии (без жеста запрос обычно отклоняется — это ничего не
   стоит), а касание остаётся запасным путём: его может сделать взрослый. */
function keepFullscreen() {
  if (installedApp) return; // у установленного приложения это режим окна, а не состояние
  for (const ev of ['visibilitychange', 'pageshow', 'resize', 'fullscreenchange']) {
    addEventListener(ev, () => { if (document.visibilityState === 'visible') requestFullscreen(); });
  }
  addEventListener('pointerdown', requestFullscreen);
}

/* Блокировка снимается при каждом скрытии страницы, поэтому её мало взять
   один раз — её надо брать заново каждый раз, когда страница снова видна.
   Без этого экран гаснет посреди забега, и это самая вероятная из помех.

   А в самом забеге она может быть и не нужна — см. настройку `screenRun`.
   Смотреть на экран телефона в забеге некому, а стоит он по журналу 8 fps.
   Поэтому у блокировки есть политика: `wantAwake` говорит, нужна ли она прямо
   сейчас, и её обязан уважать обработчик `visibilitychange` — иначе возврат из
   скрытия посреди забега молча вернул бы блокировку и испортил замер. */
let wakeLock = null;
let wantAwake = true;
// Начальное состояние — именно 'awake', а не null: иначе первый же show()
// увидит «политика сменилась» и запросит блокировку второй раз поверх взятой.
let screenPolicy = 'awake';

async function acquireWake(why) {
  if (!navigator.wakeLock || !wantAwake) return;
  if (document.visibilityState !== 'visible') return;
  // Уже держим — второй запрос осиротил бы первую блокировку: releaseWake
  // отпустил бы только новую, экран остался бы горящим, и настройка
  // «может гаснуть» молча не делала бы ничего.
  if (wakeLock) return;
  try {
    const held = await navigator.wakeLock.request('screen');
    // Политика могла перевернуться, пока обещание летело. Тогда отпускаем
    // сразу: иначе блокировка висела бы против политики, и отпустить её было
    // бы нечем — releaseWake увидел бы null и вышел.
    if (!wantAwake) {
      try { await held.release(); } catch { /* уже отпущена */ }
      return;
    }
    /* Систему никто не обязывал держать её вечно: при скрытии страницы она
       отпускает блокировку сама. Без этого слушателя `wakeLock` остался бы
       ненулевым, проверка «уже держим» выше запретила бы взять заново — и
       экран погас бы в меню, то есть ровно там, где он нужен. */
    held.addEventListener?.('release', () => {
      if (wakeLock === held) { wakeLock = null; updateStatus(); }
    });
    wakeLock = held;
    log.event('wakelock', { got: true, why });
  } catch (e) {
    log.event('wakelock', { got: false, why: String(e?.name || e) });
  }
  updateStatus();
}

async function releaseWake(why) {
  if (!wakeLock) return;
  const held = wakeLock;
  // Обнуляем ДО await: иначе второй вызов успеет пройти проверку и отпустить
  // уже отпущенное.
  wakeLock = null;
  try { await held.release(); } catch { /* уже отпущена системой — не беда */ }
  log.event('wakelock', { got: false, released: true, why });
  updateStatus();
}

/* Применить политику экрана. Вызывается на каждой смене стадии и экрана, то
   есть часто, поэтому действует только на переходах: запрашивать блокировку по
   нескольку раз в секунду — верный способ получить отказ от браузера.

   Смотрит и на стадию, и на показанный экран. Одной стадии мало: настройка
   переключается из родительского меню, то есть ровно тогда, когда взрослый
   держит телефон в руках, — а `lastHud` в этот момент всё ещё говорит «забег».
   По одной стадии экран погас бы у него под пальцами. */
function applyScreenPolicy(inRun) {
  const onRunScreen = currentScreen === 'run';
  const want = inRun && onRunScreen && settings.get('screenRun') === 'sleep'
    ? 'sleep' : 'awake';
  if (want === screenPolicy) return;
  screenPolicy = want;
  wantAwake = want === 'awake';
  if (wantAwake) acquireWake('policy'); else releaseWake('run');
}

async function keepScreenAwake() {
  if (!navigator.wakeLock) return;
  await acquireWake('start');
  addEventListener('visibilitychange', () => acquireWake('visible'));
}

// ─────────────────────────── полоса состояния ───────────────────────────

/* Предназначена взрослому: по ней видно, почему картинка на телевизоре
   выглядит не так, как ожидалось. Ребёнку она не мешает — мелкая и в углу. */
function updateStatus() {
  const mark = (ok, yes, no) => `<b class="${ok ? 'yes' : 'no'}">${ok ? yes : no}</b>`;
  const debug = settings.get('debug');
  $('status').innerHTML = [
    mark(installedApp, 'приложение', 'вкладка браузера'),
    mark(!!document.fullscreenElement || installedApp, 'во весь экран', 'не во весь экран'),
    mark(!!wakeLock, 'экран не гаснет', 'экран может погаснуть'),
    // Включённую отладку надо видеть, не заходя в меню: иначе однажды ребёнку
    // дадут поиграть с синтетическим источником и будут гадать, почему он не
    // влияет на игру.
    ...(debug === 'off' ? [] : [mark(false, '', `отладка: ${settings.label('debug')}`)]),
    // Выключенный кэш — состояние, которое меняет поведение и о котором легко
    // забыть: игра перестаёт работать без сети. Поэтому его видно.
    ...(settings.get('cache') === 'on' ? [] : [mark(false, '', 'офлайн-кэш выключен')]),
    // Версия: по ней видно, доехала ли сборка до телефона. Номер тот же, что
    // у офлайн-кэша, — значит он же отвечает на вопрос «какая версия сейчас
    // лежит в кэше», а не только «какая страница открыта».
    `<span class="ver">${VERSION} · ${BUILT_AT}</span>`,
  ].join(' · ');
}
addEventListener('fullscreenchange', updateStatus);

// ─────────────────────────────── экраны ───────────────────────────────

const SCREENS = ['gate', 'menu', 'run', 'soon', 'parent', 'logs', 'players', 'records', 'name'];

/* Телефонные экраны держат в руке — они вертикальные. Забег уходит на
   телевизор и обязан быть горизонтальным. Ориентация меняется вместе с
   экраном, а не один раз на запуске: в комиксе ровно на этом был баг —
   каталог открывался в оставшейся от прошлой истории горизонтали. */
const ORIENTATION = {
  gate: 'portrait', menu: 'portrait', soon: 'portrait',
  parent: 'portrait', logs: 'portrait',
  players: 'portrait', records: 'portrait', name: 'portrait',
  run: 'landscape',
};

/* Экраны, в которые не «возвращаются»: previous на них не переписывается.

   Три новых здесь по той же причине, что настройки и журнал: из каждого есть
   свой выход, и он знает, куда именно. Экран имени вызывается и из меню
   игроков, и прямо с финиша — поэтому цель возврата у него своя переменная, а
   не общий previous, который к моменту возврата успел бы стать другим. */
const ADULT = new Set(['parent', 'logs', 'players', 'records', 'name']);
let previous = 'menu';

let currentScreen = null;

function show(name) {
  currentScreen = name;
  for (const id of SCREENS) $(id).hidden = id !== name;
  if (!ADULT.has(name)) previous = name;
  /* Полный экран запрашивается перед блокировкой ориентации, а не параллельно:
     на Android lock() без полноэкранного режима просто отказывает, и забег
     открывается горизонтальной вёрсткой внутри вертикального экрана. Если
     откажет и так — вместо игры покажется подсказка повернуть телефон, она на
     CSS и от успеха блокировки не зависит. */
  requestFullscreen().then(() => lockOrientation(ORIENTATION[name] || 'portrait'));
  log.event('screen', { name });
  // Возврат в игру из родительского меню: показать то, что настроили.
  if (name === 'run') refreshHud();
  // Ушли с экрана забега — экран телефона снова нужен: меню держат в руке.
  if (name !== 'run') applyScreenPolicy(false);
}

/* Заглушка с честным текстом. Экран существует, содержимого пока нет — и так
   и написано, вместо имитации работающей игры. */
function showSoon(title, text) {
  $('soonTitle').textContent = title;
  $('soonText').textContent = text;
  show('soon');
}

// ─────────────────────────────── запуск ───────────────────────────────

$('installHint').hidden = installedApp;

/* Все привилегированные вызовы — внутри обработчика нажатия, по порядку:
   полный экран, ориентация, бодрый экран. Камера появится здесь же, когда
   будет распознавание позы: разрешение надо просить тем же единственным
   жестом, а не вторым отдельным. */
$('start').onclick = () => {
  // Звук будим здесь же: контекст создаётся только по жесту пользователя, а
  // в игре жестов не будет вовсе — ребёнок телефон не трогает.
  import('./audio.js').then((a) => a.wake()).catch(() => {});
  // Запускаем цепочку и сразу уходим в меню, не дожидаясь её. Ждать нельзя:
  // полный экран отвечает до трёх секунд, а на эти три секунды кнопка
  // выглядела бы сломанной — ребёнок нажал бы ещё раз и ещё.
  requestFullscreen().then(keepFullscreen).then(keepScreenAwake).then(updateStatus);
  show('menu');
};

// ────────────────────────── тренировка ──────────────────────────

let training = null;

/* Забегов подряд за эту сессию. После третьего игра предлагает передохнуть —
   это не ограничение, а напоминание взрослому: ребёнок сам не остановится. */
let runsInRow = 0;
let restSuggested = false;

const PAUSE_TEXT = {
  none: ['Вернись в рамку', 'Встань так, чтобы тебя было видно целиком'],
  lowvis: ['Тебя плохо видно', 'Нужно больше света'],
  edge: ['Встань поближе к середине', 'Ты у самого края кадра'],
  scale: ['Отойди немного назад', 'Ты слишком близко к телефону'],
  profile: ['Повернись к телевизору', 'Нужно видеть тебя спереди'],
  jump: ['Кто-то ещё в кадре', 'Играть должен кто-то один'],
};

/* Последнее состояние HUD. Нужно, чтобы перерисовать его не дожидаясь
   события от игры: взрослый меняет настройку окошка в родительском меню и
   возвращается — изменение должно быть видно сразу, а не после следующей
   собранной звезды. */
let lastHud = {};

function refreshHud() {
  if (training) renderRunHud(lastHud);
}

function renderRunHud(h = {}) {
  lastHud = h;
  // cam, а не settings: иначе имя затенило бы импортированные настройки.
  const { stage = 'free', run = 'running', why, score = 0, setupOk, framing,
    settings: cam, pipeline, calib, result, progress = 0, source } = h;
  const overlay = $('runOverlay');
  const title = $('runOverlayTitle');
  const text = $('runOverlayText');
  const numbers = $('runNumbers');

  /* Политика экрана — здесь, потому что это единственное место, которое видит
     КАЖДУЮ смену стадии: hud() зовётся и с паузы, и с отсчёта, и с возврата из
     родительского меню. */
  /* Гаснуть разрешено только пока забег ИДЁТ. На паузе — нет: игра ждёт, пока
     ребёнок вернётся в кадр, и если погасшая панель уведёт страницу в hidden,
     цикл кадров встанет, а пауза уже не разрешится сама — снимать её придётся
     руками с телефона. Отсчёт по той же причине считается забегом не идущим. */
  applyScreenPolicy(stage === 'free' && run === 'running');

  $('runScore').textContent = score;
  $('runHud').hidden = stage !== 'free';
  $('runProgressFill').style.width = `${Math.min(100, progress * 100).toFixed(1)}%`;
  overlay.classList.toggle('setup', stage === 'setup');

  /* Окошко камеры. На установке и калибровке оно нужно всегда — там без него
     непонятно, видит ли игра ребёнка вообще. Во время движения им управляет
     взрослый: пока ребёнок привыкает к границам поля, окошко помогает, а
     когда привыкнет — это лишний предмет на телевизоре.

     Полоска поля дешевле окошка по вниманию и отвечает на главный вопрос
     «я ещё в кадре?», поэтому у неё отдельный, средний вариант. */
  /* Блок результата прячется здесь, до разбора стадий, а не после.

     Раньше он прятался в конце функции — то есть никогда, если стадия уходила
     в ранний возврат. После «Ещё раз» на экране установки штатива оставались
     висеть прошлые «4 звезды собрано» и, что хуже, живая кнопка «Хватит»,
     которая сносила только что начатый забег. */
  const onResult = stage === 'result';
  $('runResult').hidden = !onResult;
  $('runResultRow').hidden = !onResult;

  /* Кнопка смены камеры живёт ровно на одном экране — установке штатива:
     только там видно, что камера снимает. Видимость решается здесь, одним
     выражением, а не прячется в каждой ветке: на блоке результата я уже один
     раз так ошибся, и он оставался висеть поверх следующего забега. */
  $('runCamSwitch').hidden = !(stage === 'setup' && source === 'camera');

  // Кнопки паузы — там же и по тому же правилу: видимость решается один раз,
  // от состояния, а не прячется по веткам.
  const наПаузе = stage === 'free' && run === 'paused' && h.manual;
  $('runPauseRow').hidden = !наПаузе;
  $('runExit').hidden = !(stage === 'free' && !наПаузе);

  const want = settings.get('preview');
  const inGame = stage === 'free';
  // На установке и калибровке окошко нужно всегда, в игре — по настройке, а
  // на экране результата не нужно вовсе: там оно лезет поверх текста.
  const setupLike = stage === 'setup' || stage === 'calibrate';
  const showPreview = setupLike || (inGame && want === 'on');
  const showField = inGame && want !== 'off';

  $('runPreview').hidden = !showPreview;
  $('runPreview').classList.toggle('watch', inGame);
  $('runField').hidden = !showField;
  $('runSilhouette').hidden = inGame;
  if (showPreview) sizeSkeleton();

  if (stage === 'setup') {
    // Экран для взрослого: его читают через комнату, поэтому числа крупные,
    // а подсказка говорит, что делать, а не что не так.
    overlay.hidden = false;
    numbers.hidden = false;
    $('runNext').hidden = false;
    $('runNext').textContent = setupOk ? 'Всё видно, дальше' : 'Всё равно дальше';
    // Переключать камеру имеет смысл только здесь: это единственный экран, где
    // видно, что она снимает. И только когда камера вообще участвует.
    $('runCamSwitch').textContent = `Другая камера (сейчас ${settings.label('camera')})`;
    title.textContent = 'Поставьте телефон на штатив';
    text.textContent = framing?.hint || 'Ребёнок должен помещаться в рамку целиком';
    $('runSilhouette').classList.toggle('bad', !setupOk);
    const cell = (label, value, good) =>
      `<div class="${good === undefined ? '' : good ? 'good' : 'bad'}"><b>${value}</b>${label}</div>`;
    numbers.innerHTML = [
      cell('камера', cam ? `${cam.width}×${cam.height}` : '—'),
      cell('кадров в секунду', cam?.frameRate ? Math.round(cam.frameRate) : '—',
        cam?.frameRate ? cam.frameRate >= 20 : undefined),
      cell('ребёнок в кадре', framing ? `${Math.round(framing.fill * 100)}%` : '—', framing?.ok),
      cell('уверенность', h.vis != null ? h.vis.toFixed(2) : '—', h.vis >= 0.6),
      cell('конвейер', pipeline || '—'),
    ].join('');
    return;
  }

  if (stage === 'calibrate') {
    /* Два адресата на одном экране, и регистры путать нельзя. Заголовок —
       ребёнку: короткая команда, которую видно через комнату. Строка под ним —
       взрослому: что происходит и что делать, если не выходит. Ребёнок
       инструкцию не прочитает, а взрослый из «Присядь как лягушка!» не
       поймёт, что от него-то ждут показать пример.

       Прогресс ушёл из текста в картинку: зона-цель в окошке наполняется по
       мере выдержки. Точки '●' сообщали то же самое, но тому, кто и так читает
       текст, — то есть не ребёнку. */
    overlay.hidden = false;
    numbers.hidden = true;
    $('runNext').hidden = true;
    title.textContent = calib?.say || calib?.stage?.say || 'Приготовься';
    text.textContent = calib?.waiting ? 'Встань так, чтобы тебя было видно'
      : calib?.retry ? `Не вышло, пробуем ещё раз. ${calib?.adult || ''}`.trim()
        : calib?.adult || '';
    // Силуэт нужен только там, где просят ВСТАТЬ: на остальных стадиях рамка
    // в середине спорила бы с зоной, которая зовёт в сторону.
    const stand = calib?.target?.kind === 'stand';
    $('runSilhouette').hidden = !stand;
    $('runSilhouette').classList.toggle('bad', stand && !calib.target.fit);
    return;
  }

  if (stage === 'result') {
    restSuggested = runsInRow >= FINISH.restAfterRuns;
    overlay.hidden = false;
    numbers.hidden = true;
    $('runNext').hidden = true;
    title.textContent = result?.praise || 'Добежал!';
    text.textContent = recordError
      ? 'Не получилось записать результат — на телефоне нет места'
      : restSuggested
        ? 'Три забега подряд — самое время передохнуть'
        : 'Финиш!';
    const st = result?.stars ?? 0;
    const ht = result?.hits ?? 0;
    const total = result?.starsTotal ?? 0;
    $('runResult').innerHTML = [
      /* Когда известно, сколько колец было, существительное уходит совсем:
         «3 из 3 звезды собрано» — не по-русски (после «из N» нужен родительный
         падеж, и он не совпадает с падежом при самом числе), а разводить ещё
         одну таблицу форм ради одной строки дороже, чем её не писать. */
      total
        ? `<div class="stars">Собрано <b>${st}</b> из ${total}</div>`
        : `<div class="stars"><b>${st}</b> ${plural(st, STARS)} собрано</div>`,
      `<div><b>${ht}</b> ${plural(ht, TIMES)} задел</div>`,
      // Длина забега была в result с самого начала и не показывалась. А без
      // неё результат не прочитать: пять минут и одна минута дают разные
      // числа колец, и сравнивать их глазами бессмысленно.
      `<div class="when">${runLengthLabel(result?.durationS)}</div>`,
    ].join('');
    /* Записать результат можно один раз, и только пока есть что записывать.

       Две кнопки, а не одна: обычный случай — одно нажатие, имя уже выбрано
       перед забегом. «Другое имя» нужно, когда за телефон встал кто-то ещё, и
       без него пришлось бы возвращаться в меню, теряя результат.

       Имя через двоеточие, а не «записать за Богданом»: падеж введённого имени
       нам неизвестен, а «за Богдан 1» хуже, чем отсутствие предлога. */
    $('runSave').hidden = !result;
    $('runSave').disabled = recorded;
    $('runSave').textContent = recorded ? 'Записано ✓' : `Записать: ${players.name()}`;
    $('runSaveAs').hidden = !result || recorded;
    return;
  }
  const stopped = run === 'paused' || run === 'countdown';
  overlay.hidden = !stopped;
  numbers.hidden = true;
  $('runNext').hidden = true;
  /* При синтетическом источнике так и написано. Это не придирка: с ним игра
     ведёт себя почти как настоящая, и забыть, что камера не участвует, очень
     легко — а потом удивляться, почему «распознавание работает идеально». */
  const fake = source === 'fake';
  $('runSeen').textContent = fake ? 'синтетика, камера не работает'
    : stopped ? 'тебя не видно' : 'вижу тебя';
  $('runSeen').classList.toggle('lost', stopped || fake);
  if (run === 'paused' && h.manual) {
    title.textContent = 'Пауза';
    text.textContent = 'Можно передохнуть';
  } else if (run === 'paused') {
    const [t, x] = PAUSE_TEXT[why] || PAUSE_TEXT.none;
    title.textContent = t;
    text.textContent = x;
  } else if (run === 'countdown') {
    title.textContent = 'Начинаем!';
    text.textContent = 'Приготовься';
  }
}

$('runNext').onclick = () => training?.next();

$('runCamSwitch').onclick = async () => {
  $('runCamSwitch').disabled = true;
  try {
    await training?.switchCamera();
  } catch (e) {
    log.event('error', { where: 'switchCamera', message: String(e?.message || e) });
    showSoon('Не получилось переключить камеру', String(e?.message || e));
  } finally {
    $('runCamSwitch').disabled = false;
  }
};

/* Запуск тренировки. Общий для кнопки меню и для «ещё раз» на финише: две
   копии разошлись бы, и повторный забег однажды поехал бы с другими
   настройками, чем первый. */
async function startTraining() {
  // Новый забег — новый результат: прошлая запись в таблицу не должна
  // блокировать запись следующей.
  recorded = false;
  recordError = false;
  const { wantedSource } = await import('./pose.js');
  const want = wantedSource();

  if (want.source === 'camera') {
    // Комплект проверяется до запуска. Наполовину закэшированная модель не
    // даёт ошибки сети — она даёт молчаливый abort внутри wasm, и по симптому
    // это неотличимо от дефекта кода.
    const { checkVendor } = await import('./vendor.js');
    const v = await checkVendor();
    log.event('offline.check', {
      ok: v.ok, skipped: v.skipped || null, cache: v.cache || null,
      missing: v.missing || [],
    });
    if (!v.ok) {
      // Перечисляем, чего именно не хватает: «что-то не скачалось» — ответ,
      // с которым нельзя ничего сделать, а имена файлов попадут и в журнал.
      showSoon('Нужен интернет один раз',
        'Не хватает файлов распознавания движений: ' + v.missing.join(', ')
        + '. Подключитесь к сети, откройте приложение один раз и дождитесь загрузки — '
        + 'дальше оно работает без сети.');
      return;
    }
  }

  const { createTraining } = await import('./train.js');
  await training?.stop();
  show('run');
  runsInRow++;
  training = createTraining({
    canvas: $('runCanvas'),
    video: $('runVideo'),
    skeleton: $('runSkeleton'),
    field: $('runField'),
    fieldMark: $('runFieldMark'),
    onHud: renderRunHud,
  });
  renderRunHud({ stage: 'setup', score: 0 });
  await training.start({ source: want.source, script: want.script });
}

$('goTrain').onclick = async () => {
  $('goTrain').disabled = true;
  try {
    runsInRow = 0;
    restSuggested = false;
    await startTraining();
  } catch (e) {
    // Ошибку надо показать, а не проглотить: на телефоне консоли нет, и
    // «ничего не произошло» — худший из возможных ответов.
    log.event('error', { where: 'goTrain', message: String(e?.message || e) });
    await training?.stop().catch(() => {});
    training = null;
    showSoon('Не получилось начать', String(e?.message || e));
  } finally {
    $('goTrain').disabled = false;
  }
};

$('runAgain').onclick = async () => {
  if (!training) return;
  restSuggested = false;
  await startTraining();
};

$('runDone').onclick = async () => {
  runsInRow = 0;
  restSuggested = false;
  await training?.stop();
  training = null;
  show('menu');
};

$('runExit').onclick = () => training?.pauseManual();

$('runResume').onclick = () => training?.resumeManual();

/* Выход в меню прерывает забег, и это намеренно: продолжать с середины
   нечего — ребёнок уже ушёл от камеры, калибровка сцены могла устареть, а
   половина забега без начала не считается результатом. */
$('runToMenu').onclick = async () => {
  await training?.stop();
  training = null;
  runsInRow = 0;
  restSuggested = false;
  log.event('run.abort', { where: 'pause' });
  show('menu');
};

$('goPlay').onclick = () => showSoon('Игра',
  'Забег до финиша ещё не собран. По плану это этап 5 — после того, как тренировка измерит '
  + 'время реакции и по нему будут пересчитаны скорость и длина телеграфа.');

$('soonBack').onclick = () => show('menu');

// ────────────────────── родительское меню ──────────────────────

/* Второй вход — долгое удержание правого верхнего угла. Он остаётся потому,
   что работает на любом экране, включая забег: кнопка есть только в меню, а
   настройки иногда нужны, не выходя из игры. */
{
  let timer = 0;
  const corner = $('parentCorner');
  corner.addEventListener('pointerdown', () => {
    timer = setTimeout(() => { renderParent(); show('parent'); }, 1200);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    corner.addEventListener(ev, () => clearTimeout(timer));
  }
}

const PARENT_ROWS = [
  ['setLen', 'lenV', 'runLength'],
  ['setSpeed', 'speedV', 'speed'],
  ['setCrouch', 'crouchV', 'crouch'],
  ['setSound', 'soundV', 'sound'],
  ['setPreview', 'previewV', 'preview'],
  ['setScreenRun', 'screenRunV', 'screenRun'],
  ['setDebug', 'debugV', 'debug'],
  ['setCache', 'cacheV', 'cache'],
];

function renderParent() {
  for (const [, out, name] of PARENT_ROWS) $(out).textContent = settings.label(name);
}

for (const [btn, out, name] of PARENT_ROWS) {
  $(btn).onclick = () => {
    $(out).textContent = settings.cycle(name);
    refreshHud();  // настройка окошка должна отзываться сразу
    updateStatus(); // отладка и состояние кэша — в полосе состояния
    // Выключение кэша должно срабатывать сразу, а не со следующего запуска:
    // иначе взрослый выключает его, видит прежнее поведение и решает, что
    // настройка не работает.
    if (name === 'cache' && settings.get('cache') === 'off') dropOfflineCache();
  };
}

$('recal').onclick = () => {
  // Через calibrate.js, а не строкой-литералом в localStorage: калибровка
  // теперь лежит у игрока, и прямое удаление ключа чистило бы не то место —
  // кнопка «сбросить» молча перестала бы работать.
  clearCalibration();
  $('recal').textContent = `Калибровка сброшена (${players.name()})`;
  setTimeout(() => { $('recal').textContent = 'Сбросить калибровку'; }, 2000);
};

$('goParent').onclick = () => { renderParent(); show('parent'); };

/* Выгрузка журнала прямо из настроек, одной кнопкой. Подробный экран остаётся,
   но когда что-то пошло не так, лишний переход — это лишний шанс потерять
   запись: журнал пишется дальше и вытесняет старое. */
$('saveLogs').onclick = async () => {
  const b = $('saveLogs');
  const было = b.textContent;
  b.disabled = true;
  b.textContent = 'Собираю…';
  try {
    const r = await log.save();
    b.textContent = r.shared === 'shared' ? 'Отправлено' : 'Сохранено в «Загрузки»';
  } catch (e) {
    b.textContent = 'Не получилось';
    log.event('error', { where: 'saveLogs', message: String(e?.message || e) });
  } finally {
    b.disabled = false;
    setTimeout(() => { b.textContent = было; }, 4000);
  }
};

$('parentBack').onclick = () => show(previous);

// ───────────────── игроки, имена и таблица рекордов ─────────────────

/* Три экрана и одна связь между ними.

   Калибровка и рекорды принадлежат игроку, а не телефону. Пока запись была
   одна, взрослый и ребёнок затирали её друг другу: тот, кто играл вторым,
   проходил двадцать секунд калибровки заново при каждом забеге, хотя код
   переиспользования написан и работает — в журнале это видно строкой
   calib.reuse reuse:false had:true stale:true. Оттуда же берётся имя для
   таблицы: на финише его не надо набирать, оно уже выбрано перед забегом. */

/* Записан ли ТЕКУЩИЙ показанный результат. Флаг живёт здесь, а не в train.js:
   запись — дело оболочки, а игра про таблицу рекордов не знает вовсе. */
let recorded = false;

/* И не отказало ли хранилище на последней попытке. Отдельным флагом, потому
   что молчаливый отказ здесь дороже всего: забег уже не повторить. */
let recordError = false;

/** Длина забега словами. Берётся из тех же вариантов, что в настройках. */
function runLengthLabel(seconds) {
  const s = Math.round(seconds || 0);
  const known = OPTIONS.runLength.find((o) => o.value === s);
  return known ? known.label : `${s} с`;
}

function renderWho() {
  $('whoV').textContent = players.name();
}

// ── экран «кто играет» ──

const DROP_LABEL = 'Удалить этого';

function renderPlayers() {
  /* Взведённое удаление сбрасывается при каждой перерисовке — то есть при
     входе на экран и при смене игрока. Иначе оно пережило бы уход в меню и
     возврат, и следующее нажатие снесло бы игрока вместе с калибровкой и
     рекордами с первого раза, без второго подтверждения. */
  delete $('playerDrop').dataset.armed;
  $('playerDrop').textContent = DROP_LABEL;

  const list = players.all();
  const me = players.current()?.id;
  $('playerList').innerHTML = list.map((p) => {
    /* Два независимых факта, и показывать надо оба. Пока «есть калибровка»
       служило признаком «играл», профиль, заведённый кнопкой «Другое имя» на
       финише, навсегда читался как «без калибровки» — а у него есть рекорды и
       нет калибровки по построению, её ему никто не предлагал. */
    const note = [
      p.runs ? count(p.runs, RUNS) : null,
      p.hasCalib ? null : 'без калибровки',
    ].filter(Boolean).join(' · ') || 'ещё не играл';
    return `<button data-pick="${p.id}" class="${p.id === me ? '' : 'ghost'}">`
      + `${safeText(p.name)}<small>${note}</small></button>`;
  }).join('');
  for (const b of $('playerList').querySelectorAll('[data-pick]')) {
    b.onclick = () => {
      players.select(b.dataset.pick);
      renderPlayers();
      renderWho();
      $('playersMsg').textContent = `Играет ${players.name()}. Калибровка у каждого своя.`;
    };
  }
  $('playerDrop').disabled = list.length <= 1;
}

$('goPlayers').onclick = () => { $('playersMsg').textContent = ''; renderPlayers(); show('players'); };
$('playersBack').onclick = () => { renderWho(); show('menu'); };
$('playerAdd').onclick = () => askName('new');

/* Удаление уносит и калибровку, и рекорды этого игрока — поэтому в два
   нажатия. Диалога подтверждения нет намеренно: confirm() на Android выводит
   приложение из полноэкранного режима, а забег после этого открывается
   горизонтальной вёрсткой внутри вертикального экрана. */
$('playerDrop').onclick = () => {
  const me = players.current();
  if (!me) return;
  if ($('playerDrop').dataset.armed !== me.id) {
    $('playerDrop').dataset.armed = me.id;
    $('playerDrop').textContent = `Удалить ${me.name}? Нажмите ещё раз`;
    return;
  }
  players.remove(me.id);
  renderPlayers();        // здесь же снимается взвод
  renderWho();
  $('playersMsg').textContent = `${me.name} удалён вместе с калибровкой и рекордами.`;
};

// ── ввод имени ──

/* Что сделать с введённым именем и куда вернуться. Своя переменная, а не
   общий previous: экран имени вызывается и из меню игроков, и прямо с финиша,
   а previous к моменту возврата успел бы стать другим. */
let nameMode = 'new';

const NAME_HINT = 'До 12 букв — длиннее не прочитать на телевизоре.';

function askName(mode) {
  nameMode = mode;
  $('nameTitle').textContent = mode === 'record' ? 'Чей это результат?' : 'Как тебя зовут?';
  $('nameHint').textContent = NAME_HINT;
  $('nameInput').value = '';
  show('name');
  // Фокус после показа: скрытому полю клавиатуру не поднять.
  setTimeout(() => $('nameInput').focus(), 50);
}

$('nameSave').onclick = () => {
  /* В режиме записи игрок НЕ переключается: экран спрашивает «чей это
     результат», то есть подпись, а не «кто играет дальше». Иначе гость,
     которому приписали забег, становится текущим, и у ребёнка следующий
     забег начинается с двадцати секунд калибровки по пустому профилю. */
  const forRecord = nameMode === 'record';
  const added = players.add($('nameInput').value, { select: !forRecord });
  if (!added) { $('nameHint').textContent = 'Нужна хотя бы одна буква.'; return; }
  $('nameHint').textContent = NAME_HINT;
  if (forRecord) { saveRecord(added.id); return; }
  renderWho();
  renderPlayers();
  show('players');
};

$('nameCancel').onclick = () => {
  $('nameHint').textContent = NAME_HINT;
  if (nameMode === 'record') { refreshHud(); show('run'); return; }
  renderPlayers();
  show('players');
};

// Enter на телефонной клавиатуре — то же, что «Готово».
$('nameInput').onkeydown = (e) => { if (e.key === 'Enter') $('nameSave').onclick(); };

// ── таблица рекордов ──

/* Какая длина забега сейчас показана. Отдельная таблица на каждую: сырые
   кольца за пять минут и за одну несравнимы, и складывать их в один список
   значит выдавать длинный забег за мастерство. */
let recLen = settings.get('runLength') || 300;

/** Длины, по которым есть смысл показывать таблицу: настроенные плюс сыгранные. */
function recLengths() {
  const set = new Set(OPTIONS.runLength.map((o) => o.value));
  for (const s of players.lengths()) set.add(s);
  return [...set].sort((a, b) => a - b);
}

/* Сколько строк показываем. Хранится до RECORDS_MAX на игрока на длину, но
   таблица рекордов — это верхушка, а не журнал.

   Число не косметическое: в приложении нет прокрутки нигде (`html, body`
   стоят с `overflow: hidden`, и это осознанно — экран держат в руке и тычут
   пальцем, случайный свайп не должен уводить содержимое). Экран `.sheet`
   центрирует колонку по вертикали, поэтому длинный список вылезает за ОБА
   края: за экран уходят и заголовок, и переключатель длины, и кнопка
   «Назад», и вернуться становится нечем. Порог наступает примерно на двадцати
   записях — то есть внутри того запаса, который потолок в 50 как раз и копит.

   Своя строка всегда дописывается снизу, даже если не попала в десятку: иначе
   ребёнок, собравший меньше всех, не видит себя в таблице вовсе. */
const RECORDS_SHOWN = 10;

function recRow(r, place, me) {
  const total = r.starsTotal ? ` из ${r.starsTotal}` : '';
  const when = new Date(r.at).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
  return `<div class="rec${r.playerId === me ? ' me' : ''}">`
    + `<span class="place">${place}</span>`
    + `<span class="who">${safeText(r.name)}</span>`
    + `<span class="num">${r.stars}${total}</span>`
    + `<span class="when">задел ${r.hits} · ${when}</span>`
    + '</div>';
}

function renderRecords() {
  const lengths = recLengths();
  if (!lengths.includes(recLen)) recLen = lengths[0];
  $('recLenV').textContent = runLengthLabel(recLen);
  const rows = players.records(recLen);
  const me = players.current()?.id;
  if (rows.length === 0) {
    $('recList').innerHTML = '<p class="lead dim">Здесь пока пусто. '
      + 'В таблицу попадает забег, доведённый до финиша.</p>';
    return;
  }
  const top = rows.slice(0, RECORDS_SHOWN);
  const html = top.map((r, i) => recRow(r, i + 1, me));
  const mineAt = rows.findIndex((r) => r.playerId === me);
  if (mineAt >= RECORDS_SHOWN) {
    html.push('<div class="rec more">…</div>', recRow(rows[mineAt], mineAt + 1, me));
  }
  $('recList').innerHTML = html.join('');
}

/* Откуда пришли в таблицу. С финиша «Назад» обязано вернуть на экран
   результата, а не в меню: там ещё живые «Ещё раз» и «Вернуться в меню», и
   уводить забег в небытие молча — значит потерять его. */
let recordsFrom = 'menu';

$('goRecords').onclick = () => { recordsFrom = 'menu'; renderRecords(); show('records'); };
$('recordsBack').onclick = () => {
  if (recordsFrom === 'run' && training) { refreshHud(); show('run'); return; }
  show('menu');
};
$('recLen').onclick = () => {
  const lengths = recLengths();
  recLen = lengths[(lengths.indexOf(recLen) + 1) % lengths.length];
  renderRecords();
};

/* Запись результата. Зовётся только с экрана финиша: выход через паузу этот
   путь не проходит вовсе, и это не фильтр, а отсутствие вызова — забег,
   прерванный на середине, результатом не является. */
function saveRecord(playerId) {
  const r = training?.result;
  if (!r || recorded) { renderRecords(); show('records'); return; }
  // playerId приходит с экрана имени и означает «подписать этим», а не
  // «переключиться на него»; без него пишем текущему игроку.
  const written = players.addRecord({
    playerId,
    durationS: r.durationS, stars: r.stars, score: r.score,
    starsTotal: r.starsTotal, hits: r.hits,
  });
  /* Записалось ли на самом деле. players.addRecord отдаёт null, если запись
     не приняли, а сохранение в localStorage молчит при любом отказе — игра
     важнее журнала. Без этой проверки кнопка говорила бы «Записано ✓» и
     уводила на таблицу, в которой забега нет: тихая потеря ровно того, ради
     чего экран существует. */
  if (!written) {
    recordError = true;
    log.event('record.fail', { durationS: Math.round(r.durationS) });
    refreshHud();
    show('run');
    return;
  }
  recordError = false;
  recorded = true;
  recordsFrom = 'run';
  log.event('record.save', {
    stars: r.stars, score: r.score, hits: r.hits, durationS: Math.round(r.durationS),
  });
  recLen = Math.round(r.durationS);
  renderRecords();
  show('records');
}

$('runSave').onclick = () => saveRecord();
$('runSaveAs').onclick = () => askName('record');

// ────────────────────────── журнал событий ──────────────────────────

const MB = 1024 * 1024;
const fmtMB = (b) => (b / MB).toFixed(b < MB ? 2 : 1);

async function renderLogs() {
  $('logLimits').textContent = `Потолок — ${log.LIMITS.bytes / MB} МБ и `
    + `${count(log.LIMITS.sessions, SESSIONS)}. При переполнении сами удаляются самые старые.`;
  const s = await log.status();
  if (s.broken) {
    $('logStat').textContent = 'Журнал недоступен: база не открылась. '
      + 'Так бывает в приватном режиме или когда на телефоне кончилось место.';
    return;
  }
  const when = s.from
    ? `с ${new Date(s.from).toLocaleString('ru')} по ${new Date(s.to).toLocaleString('ru')}`
    : 'записей пока нет';
  $('logStat').textContent = `${count(s.sessions, SESSIONS)}, ${count(s.events, EVENTS)}, `
    + `${fmtMB(s.bytes)} МБ (${Math.round(s.share * 100)}% потолка). ${when}.`;
}

$('goLogs').onclick = () => { show('logs'); renderLogs(); };
$('logsBack').onclick = () => show('parent');

$('logSave').onclick = async () => {
  $('logMsg').textContent = 'Собираю…';
  try {
    const r = await log.save();
    // Сообщение из двух частей: что с файлом и что с отправкой. Они
    // независимы — отправку можно отменить, а файл при этом остаётся.
    const file = r.saved
      ? `Сохранено в «Загрузки»: ${r.name} (${fmtMB(r.bytes)} МБ).`
      : `Файл сохранить не удалось (${fmtMB(r.bytes)} МБ).`;
    const sent = {
      shared: 'Отправлено.',
      cancelled: 'Отправку отменили — файл на телефоне остался.',
      failed: 'Поделиться не получилось, но файл сохранён.',
      unavailable: 'Телефон не предложил «Поделиться» — возьмите файл из «Загрузок».',
    }[r.shared];
    $('logMsg').textContent = `${file} ${sent}`;
  } catch (e) {
    $('logMsg').textContent = 'Не получилось выгрузить: ' + (e?.message || e);
  }
};

$('logClear').onclick = async () => {
  // Без подтверждения: журнал не ценность сам по себе, а выгрузка уже сделана
  // тем, кому он нужен. Лишний вопрос на экране, который держат в руке, дороже.
  await log.clear();
  $('logMsg').textContent = 'Журнал очищен.';
  renderLogs();
};

// ───────────────────────── service worker ─────────────────────────

/** Снимает service worker и удаляет все кэши. Возвращает, что нашлось. */
async function dropOfflineCache() {
  const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
  for (const r of regs) await r.unregister();
  const keys = (await caches?.keys?.()) || [];
  for (const k of keys) await caches.delete(k);
  return { registrations: regs.length, caches: keys };
}

$('resetCache').onclick = async () => {
  const dropped = await dropOfflineCache();
  log.event('cache.reset', dropped);
  location.reload();
};

/* Офлайн-кэш выключается на localhost всегда и по настройке — где угодно.

   На localhost иначе правка кода не доезжает до браузера, и полдня уходит на
   отладку изменений, которых страница просто не видит. По настройке — чтобы то
   же самое можно было сделать на телефоне, где кэш и доставляет больше всего
   хлопот: там он держит не только код, но и семнадцать мегабайт MediaPipe.

   Параметр адреса ?nocache=1 сильнее настройки и нужен для случая, когда в
   кэше уже лежит сломанная версия и до меню не добраться. */
const offlineWanted = !isDev && flag('nocache') === null && settings.get('cache') === 'on';

if (!offlineWanted) {
  dropOfflineCache();
} else if ('serviceWorker' in navigator) {
  /* updateViaCache: 'none' — не косметика. GitHub Pages отдаёт файлы с
     max-age=600, и сам sw.js тоже: браузер до десяти минут не видит, что
     вышла новая версия, а service worker всё это время отдаёт из своего кэша
     старые модули. Проверено на себе — полчаса ушло на отладку изменений,
     которых страница просто не видела. Этот флаг заставляет проверять сам
     sw.js всегда по сети, и новая сборка доезжает с первой перезагрузкой. */
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

log.watchLifecycle();
renderWho();
show('gate');
updateStatus();
