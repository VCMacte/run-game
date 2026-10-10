// Офлайн-кэш. Игра обязана работать без сети: телефон стоит на штативе в
// комнате, и проверять, доступен ли интернет, перед запуском никто не будет.
//
// Списки не ведутся руками — их пересобирает tools/make-sw.mjs, он же пишет
// оба имени кэша.
//
// Кэша ДВА, и это не аккуратность, а исправление настоящей поломки.
//
// Был один, с номером сборки в имени, и каждая сборка заводила новый — то есть
// качала заново ВСЁ, включая 17.5 МБ MediaPipe. В комментарии ниже стояло
// обещание, что неизменившиеся файлы вернутся как 304 и заново не поедут. На
// GitHub Pages это неверно: он ставит всем файлам `Last-Modified` равным
// времени ДЕПЛОЯ и собирает ETag из него же (проверено запросами: совпавший
// ETag — 304, разошедшийся — полное тело 3.5 МБ). Значит каждый push менял
// валидатор у всех файлов сразу, и ревалидация давала 200.
//
// Цена этого — 8.6 МБ в сжатом виде на каждую сборку, по телефонной связи, и
// игра до их конца не стартует: js/vendor.js честно покажет «нужен интернет
// один раз». Поэтому MediaPipe переехал в собственный кэш, имя которого
// содержит отпечаток его содержимого, а не номер сборки: правка игры имя не
// меняет, и перекачивать нечего.
const CACHE = 'run-v98';

/* Имя задаётся ОТПЕЧАТКОМ содержимого vendor/, а не номером сборки, и это и
   есть весь смысл разделения: то же имя — те же байты по построению, значит
   «файл уже лежит» можно проверять наличием, не сверяя его ни с сетью, ни с
   размером. Поменяли MediaPipe — отпечаток другой, кэш другой, старый
   удаляется в activate.

   Один раз перекачать всё-таки придётся: у тех, кто уже установил приложение,
   MediaPipe лежит в старом общем кэше, а переносить байты через границу
   отпечатка нельзя — про них неизвестно, какой версии vendor они отвечают.
   Это разовая цена перехода, и она честнее молчаливого переноса. */
const VENDOR_CACHE = 'run-vendor-d6077645';
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
  './js/players.js',
  './js/pose.camera.js',
  './js/pose.engine.js',
  './js/pose.js',
  './js/pose.pack.js',
  './js/pose.worker.js',
  './js/preview.js',
  './js/settings.js',
  './js/signals.js',
  './js/text.js',
  './js/theme.js',
  './js/train.js',
  './js/util.js',
  './js/vendor.js',
  './js/version.js',
  './js/view.js',
  './assets/sky-night.webp',
  './assets/sky-sunset.webp',
  './assets/sky.webp',
];

/* MediaPipe отдельно. Делит список именно граница «меняется со сборкой / не
   меняется»: код игры правится каждый день, wasm и модель — раз в полгода. */
const VENDOR_ASSETS = [
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

   `cache: 'no-cache'` заставляет сходить на сервер с условным запросом. Для
   кода приложения этого достаточно — он мелкий, и перекачать его не жалко.
   Для MediaPipe не достаточно (см. про ETag деплоя выше), поэтому его спасает
   не этот флаг, а отдельный кэш с отпечатком.

   Две addAll, а не одна: атомарна каждая по отдельности, то есть кэш вендора
   либо полон, либо отсутствует — частично скачанного комплекта не бывает. А
   вот РАСХОЖДЕНИЕ двух кэшей бывает: сеть кончилась между ними. Ровно это и
   проверяет checkVendor() в js/vendor.js, показывая «нужен интернет один раз»
   вместо попытки запустить распознавание на половине комплекта. */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'no-cache' })));

    /* Качается только отсутствующее. При неизменном vendor/ имя кэша то же,
       всё уже лежит, список пуст — и сборка не стоит ни одного байта. */
    const vendor = await caches.open(VENDOR_CACHE);
    const missing = [];
    for (const url of VENDOR_ASSETS) if (!(await vendor.match(url))) missing.push(url);
    if (missing.length) {
      await vendor.addAll(missing.map((url) => new Request(url, { cache: 'no-cache' })));
    }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks
      .filter((k) => k !== CACHE && k !== VENDOR_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Ответ ищется по ВСЕМ кэшам сразу: CacheStorage.match обходит их сам, и
   разделение на два кэша здесь поэтому ничего не меняет. Знать, в котором из
   них лежит файл, этому обработчику не нужно — и не надо, чтобы не пришлось
   поддерживать соответствие в двух местах. */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
