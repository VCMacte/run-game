// Офлайн-кэш. Игра обязана работать без сети: телефон стоит на штативе в
// комнате, и проверять, доступен ли интернет, перед запуском никто не будет.
//
// Список ASSETS не ведётся руками — его пересобирает tools/make-sw.mjs.
// Номер кэша поднимается тем же запуском.
const CACHE = 'run-v62';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './icons/icon-192.png',
  './icons/icon-512-maskable.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/audio.js',
  './js/calibrate.js',
  './js/camera.js',
  './js/config.js',
  './js/fake-pose.js',
  './js/level.js',
  './js/log.js',
  './js/pose.camera.js',
  './js/pose.engine.js',
  './js/pose.js',
  './js/pose.pack.js',
  './js/pose.worker.js',
  './js/preview.js',
  './js/settings.js',
  './js/signals.js',
  './js/text.js',
  './js/train.js',
  './js/util.js',
  './js/vendor.js',
  './js/version.js',
  './js/view.js',
  './vendor/mediapipe/vision_bundle.js',
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './vendor/models/pose_landmarker_lite.task',
];

/* Установка качает файлы в обход обычного кэша браузера, и это не
   перестраховка, а исправление настоящей поломки.

   GitHub Pages отдаёт всё с max-age=600. Обычный addAll берёт файлы через
   кэш браузера, поэтому свежепоставленный service worker складывал в новый
   кэш СТАРЫЕ файлы — и дальше отдавал их офлайн уже навсегда. Снаружи это
   выглядело так: версия в sw.js поднялась, приложение обновилось, а ведёт
   себя по-прежнему, и починить это нечем.

   `cache: 'no-cache'` заставляет сходить на сервер с условным запросом:
   неизменившиеся файлы вернутся как 304, то есть семнадцать мегабайт
   MediaPipe заново не поедут, а изменившиеся придут настоящими. */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'no-cache' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
