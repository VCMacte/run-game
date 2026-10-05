// Офлайн-кэш. Игра обязана работать без сети: телефон стоит на штативе в
// комнате, и проверять, доступен ли интернет, перед запуском никто не будет.
//
// Список ASSETS не ведётся руками — его пересобирает tools/make-sw.mjs.
// Номер кэша поднимается тем же запуском.
const CACHE = 'run-v22';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './icons/icon-192.png',
  './icons/icon-512-maskable.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/calibrate.js',
  './js/camera.js',
  './js/config.js',
  './js/fake-pose.js',
  './js/log.js',
  './js/pose.camera.js',
  './js/pose.engine.js',
  './js/pose.js',
  './js/pose.pack.js',
  './js/pose.worker.js',
  './js/settings.js',
  './js/signals.js',
  './js/text.js',
  './js/train.js',
  './js/util.js',
  './js/vendor.js',
  './js/view.js',
  './vendor/mediapipe/vision_bundle.js',
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './vendor/models/pose_landmarker_lite.task',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
