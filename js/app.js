// Оболочка приложения: запуск, полный экран, размеры, экраны, меню.
// Игровой логики здесь нет — она придёт отдельными модулями (js/game.js и
// соседи), а этот файл отвечает за то, чтобы приложение вообще жило на
// телефоне, стоящем на штативе, и доезжало до телевизора в приличном виде.

import { settings } from './settings.js';

const $ = (id) => document.getElementById(id);

// ─────────────────────────── общие приёмы ───────────────────────────

/* Обещания полного экрана, блокировки ориентации и разрешений умеют не
   завершаться никогда. В комиксе на этом приложение зависало на экране
   загрузки, и единственное лечение — не ждать их дольше разумного. */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(r, ms))]).catch(() => {});
}

/* Установленное приложение против вкладки браузера. Разница не косметическая:
   во вкладке на телевизор уезжают адресная строка и системные кнопки. */
const installedApp = matchMedia('(display-mode: fullscreen)').matches
  || matchMedia('(display-mode: standalone)').matches
  || navigator.standalone === true;

const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);

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

/* Ребёнок телефон не трогает, поэтому приём комикса «вернуть полный экран
   первым же касанием» здесь сам по себе не сработает. Пробуем вернуть его на
   каждом удобном событии (без жеста запрос обычно отклоняется — это ничего не
   стоит), а касание остаётся запасным путём: его может сделать взрослый. */
async function requestFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  await withTimeout(el.requestFullscreen({ navigationUI: 'hide' }), 3000);
  await withTimeout(screen.orientation?.lock?.('landscape') ?? Promise.resolve(), 1500);
}

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
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
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

const SCREENS = ['gate', 'menu', 'soon', 'parent'];
let previous = 'menu';

function show(name) {
  for (const id of SCREENS) $(id).hidden = id !== name;
  if (name !== 'parent') previous = name;
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
$('start').onclick = async () => {
  $('start').disabled = true;
  await requestFullscreen();
  keepFullscreen();
  await keepScreenAwake();
  updateStatus();
  show('menu');
  $('start').disabled = false;
};

$('goTrain').onclick = () => showSoon('Тренировка',
  'Обучающий забег ещё не собран. По плану это этап 3: шесть шагов — настройка штатива, '
  + 'калибровка, свободное движение, только бока, только присед, вместе.');

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

show('gate');
updateStatus();
