// Оболочка приложения: запуск, полный экран, размеры, экраны, меню.
// Игровой логики здесь нет — она придёт отдельными модулями (js/game.js и
// соседи), а этот файл отвечает за то, чтобы приложение вообще жило на
// телефоне, стоящем на штативе, и доезжало до телевизора в приличном виде.

import { settings } from './settings.js';
import * as log from './log.js';
import { count, SESSIONS, EVENTS } from './text.js';
import { withTimeout, isDev } from './util.js';

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
layout();
addEventListener('resize', layout);
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
  // Запускаем цепочку и сразу уходим в меню, не дожидаясь её. Ждать нельзя:
  // полный экран отвечает до трёх секунд, а на эти три секунды кнопка
  // выглядела бы сломанной — ребёнок нажал бы ещё раз и ещё.
  requestFullscreen().then(keepFullscreen).then(keepScreenAwake).then(updateStatus);
  show('menu');
};

// ────────────────────────── тренировка ──────────────────────────

let training = null;

const PAUSE_TEXT = {
  none: ['Вернись в рамку', 'Встань так, чтобы тебя было видно целиком'],
  lowvis: ['Тебя плохо видно', 'Нужно больше света'],
  edge: ['Встань поближе к середине', 'Ты у самого края кадра'],
  scale: ['Отойди немного назад', 'Ты слишком близко к телефону'],
  profile: ['Повернись к телевизору', 'Нужно видеть тебя спереди'],
  jump: ['Кто-то ещё в кадре', 'Играть должен кто-то один'],
};

function renderRunHud({ state, why, score }) {
  $('runScore').textContent = score ?? 0;
  const paused = state === 'paused' || state === 'countdown';
  $('runOverlay').hidden = !paused;
  $('runSeen').textContent = paused ? 'тебя не видно' : 'вижу тебя';
  $('runSeen').classList.toggle('lost', paused);
  if (state === 'paused') {
    const [title, text] = PAUSE_TEXT[why] || PAUSE_TEXT.none;
    $('runOverlayTitle').textContent = title;
    $('runOverlayText').textContent = text;
  } else if (state === 'countdown') {
    $('runOverlayTitle').textContent = 'Начинаем!';
    $('runOverlayText').textContent = 'Приготовься';
  }
}

$('goTrain').onclick = async () => {
  $('goTrain').disabled = true;
  try {
    const { wantedSource } = await import('./pose.js');
    const want = wantedSource();

    if (want.source === 'camera') {
      // Комплект проверяется до запуска. Наполовину закэшированная модель не
      // даёт ошибки сети — она даёт молчаливый abort внутри wasm, и по
      // симптому это неотличимо от дефекта кода.
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
    show('run');
    training = createTraining({ canvas: $('runCanvas'), onHud: renderRunHud });
    renderRunHud({ state: 'running', score: 0 });
    await training.start({ source: want.source, script: want.script });
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
];

function renderParent() {
  for (const [, out, name] of PARENT_ROWS) $(out).textContent = settings.label(name);
}

for (const [btn, out, name] of PARENT_ROWS) {
  $(btn).onclick = () => { $(out).textContent = settings.cycle(name); };
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
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

log.watchLifecycle();
show('gate');
updateStatus();
