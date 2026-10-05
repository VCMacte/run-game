// Оболочка приложения: запуск, полный экран, размеры, экраны, меню.
// Игровой логики здесь нет — она придёт отдельными модулями (js/game.js и
// соседи), а этот файл отвечает за то, чтобы приложение вообще жило на
// телефоне, стоящем на штативе, и доезжало до телевизора в приличном виде.

import { settings } from './settings.js';
import * as log from './log.js';
import { count, plural, SESSIONS, EVENTS, STARS, TIMES } from './text.js';
import { withTimeout, isDev } from './util.js';
import { FINISH } from './config.js';

const $ = (id) => document.getElementById(id);

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
   Без этого экран гаснет посреди забега, и это самая вероятная из помех. */
let wakeLock = null;
async function keepScreenAwake() {
  if (!navigator.wakeLock) return;
  const acquire = async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      log.event('wakelock', { got: true });
    } catch (e) {
      log.event('wakelock', { got: false, why: String(e?.name || e) });
    }
    updateStatus();
  };
  await acquire();
  addEventListener('visibilitychange', acquire);
}

// ─────────────────────────── полоса состояния ───────────────────────────

/* Предназначена взрослому: по ней видно, почему картинка на телевизоре
   выглядит не так, как ожидалось. Ребёнку она не мешает — мелкая и в углу. */
function updateStatus() {
  const mark = (ok, yes, no) => `<b class="${ok ? 'yes' : 'no'}">${ok ? yes : no}</b>`;
  $('status').innerHTML = [
    mark(installedApp, 'приложение', 'вкладка браузера'),
    mark(!!document.fullscreenElement || installedApp, 'во весь экран', 'не во весь экран'),
    mark(!!wakeLock, 'экран не гаснет', 'экран может погаснуть'),
  ].join(' · ');
}
addEventListener('fullscreenchange', updateStatus);

// ─────────────────────────────── экраны ───────────────────────────────

const SCREENS = ['gate', 'menu', 'run', 'soon', 'parent', 'logs'];

/* Телефонные экраны держат в руке — они вертикальные. Забег уходит на
   телевизор и обязан быть горизонтальным. Ориентация меняется вместе с
   экраном, а не один раз на запуске: в комиксе ровно на этом был баг —
   каталог открывался в оставшейся от прошлой истории горизонтали. */
const ORIENTATION = {
  gate: 'portrait', menu: 'portrait', soon: 'portrait',
  parent: 'portrait', logs: 'portrait',
  run: 'landscape',
};

const ADULT = new Set(['parent', 'logs']); // экраны, в которые не «возвращаются»
let previous = 'menu';

function show(name) {
  for (const id of SCREENS) $(id).hidden = id !== name;
  if (!ADULT.has(name)) previous = name;
  lockOrientation(ORIENTATION[name] || 'portrait');
  log.event('screen', { name });
  // Возврат в игру из родительского меню: показать то, что настроили.
  if (name === 'run') refreshHud();
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
    settings: cam, pipeline, calib, result, progress = 0 } = h;
  const overlay = $('runOverlay');
  const title = $('runOverlayTitle');
  const text = $('runOverlayText');
  const numbers = $('runNumbers');

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
  const want = settings.get('preview');
  const inGame = stage === 'free';
  // На установке и калибровке окошко нужно всегда, в игре — по настройке, а
  // на экране результата не нужно вовсе: там оно лезет поверх текста.
  const setupLike = stage === 'setup' || stage === 'calibrate';
  const showPreview = setupLike || (inGame && want === 'on');
  const showField = inGame && want !== 'off';

  $('runPreview').hidden = !showPreview;
  $('runPreview').classList.toggle('corner', stage === 'calibrate');
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
    overlay.hidden = false;
    numbers.hidden = true;
    $('runNext').hidden = true;
    title.textContent = calib?.say || calib?.stage?.say || 'Приготовься';
    text.textContent = calib?.waiting ? 'Встань так, чтобы тебя было видно'
      : calib?.retry ? 'Попробуем ещё раз'
        : calib?.progress ? '●'.repeat(Math.ceil(calib.progress * 5)) : '';
    return;
  }

  if (stage === 'result') {
    restSuggested = runsInRow >= FINISH.restAfterRuns;
    overlay.hidden = false;
    numbers.hidden = true;
    $('runNext').hidden = true;
    $('runResult').hidden = false;
    $('runResultRow').hidden = false;
    title.textContent = result?.praise || 'Добежал!';
    text.textContent = restSuggested
      ? 'Три забега подряд — самое время передохнуть'
      : 'Финиш!';
    const st = result?.stars ?? 0;
    const ht = result?.hits ?? 0;
    $('runResult').innerHTML = [
      `<div class="stars"><b>${st}</b>${plural(st, STARS)} собрано</div>`,
      `<div><b>${ht}</b>${plural(ht, TIMES)} задел</div>`,
    ].join('');
    return;
  }
  $('runResult').hidden = true;
  $('runResultRow').hidden = true;

  const stopped = run === 'paused' || run === 'countdown';
  overlay.hidden = !stopped;
  numbers.hidden = true;
  $('runNext').hidden = true;
  $('runSeen').textContent = stopped ? 'тебя не видно' : 'вижу тебя';
  $('runSeen').classList.toggle('lost', stopped);
  if (run === 'paused') {
    const [t, x] = PAUSE_TEXT[why] || PAUSE_TEXT.none;
    title.textContent = t;
    text.textContent = x;
  } else if (run === 'countdown') {
    title.textContent = 'Начинаем!';
    text.textContent = 'Приготовься';
  }
}

$('runNext').onclick = () => training?.next();

/* Запуск тренировки. Общий для кнопки меню и для «ещё раз» на финише: две
   копии разошлись бы, и повторный забег однажды поехал бы с другими
   настройками, чем первый. */
async function startTraining() {
  const { wantedSource } = await import('./pose.js');
  const want = wantedSource();

  if (want.source === 'camera') {
    // Комплект проверяется до запуска. Наполовину закэшированная модель не
    // даёт ошибки сети — она даёт молчаливый abort внутри wasm, и по симптому
    // это неотличимо от дефекта кода.
    const { checkVendor } = await import('./vendor.js');
    const v = await checkVendor();
    log.event('offline.check', {
      ok: v.ok, skipped: v.skipped || null,
      missing: v.missing?.length || 0, wrong: v.wrongSize?.length || 0,
    });
    if (!v.ok) {
      showSoon('Нужен интернет один раз',
        'Распознавание движений скачалось не полностью, поэтому тренировка пока не запустится. '
        + 'Подключитесь к сети, откройте приложение один раз и дождитесь загрузки — '
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

$('runExit').onclick = async () => {
  await training?.stop();
  training = null;
  show('menu');
};

$('goPlay').onclick = () => showSoon('Игра',
  'Забег до финиша ещё не собран. По плану это этап 5 — после того, как тренировка измерит '
  + 'время реакции и по нему будут пересчитаны скорость и длина телеграфа.');

$('soonBack').onclick = () => show('menu');

// ────────────────────── родительское меню ──────────────────────

/* Вход — долгое удержание правого верхнего угла. Ребёнок туда не полезет:
   там ничего не нарисовано и ничто не просит нажатия. */
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
];

function renderParent() {
  for (const [, out, name] of PARENT_ROWS) $(out).textContent = settings.label(name);
}

for (const [btn, out, name] of PARENT_ROWS) {
  $(btn).onclick = () => {
    $(out).textContent = settings.cycle(name);
    refreshHud(); // настройка окошка должна отзываться сразу
  };
}

$('recal').onclick = () => {
  localStorage.removeItem('run-game.calibration');
  $('recal').textContent = 'Калибровка сброшена';
  setTimeout(() => { $('recal').textContent = 'Сбросить калибровку'; }, 2000);
};

$('parentBack').onclick = () => show(previous);

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

/* На localhost service worker не регистрируется и зачищается: иначе правка
   кода не доезжает до браузера, и полдня уходит на отладку изменений, которых
   страница просто не видит. */
if (isDev) {
  navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()));
  caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k)));
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
show('gate');
updateStatus();
