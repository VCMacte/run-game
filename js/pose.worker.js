// Воркер распознавания. КЛАССИЧЕСКИЙ, не модульный — и это не вкусовщина.
//
// MediaPipe грузит свой wasm-загрузчик так:
//
//     if (typeof importScripts != 'function') { ...создать <script>... }
//     else importScripts(url)
//
// В модульном воркере importScripts не существует, а document — тем более,
// поэтому загрузчик не выполняется, ModuleFactory не выставляется, и
// createFromOptions падает с «ModuleFactory not set.». Проверено: именно так
// и случилось. В классическом воркере importScripts работает.
//
// Отсюда и устройство файла: MediaPipe подключается через importScripts
// (сборка-IIFE, кладёт глобаль Vision), а наши собственные модули — через
// динамический import(), который в классических воркерах доступен, в отличие
// от статических import.
//
// Воркер намеренно не вычисляет ничего сверх инференса: ни нормализации, ни
// жестов. Он отдаёт сырые 132 числа, и вся математика живёт на главном потоке
// в модуле, который проверяется обычным скриптом node. Десять килобайт в
// секунду — не та цена, ради которой стоит терять проверяемость.

'use strict';

let pack = null;        // модуль с упаковкой и часами
let landmarker = null;
let clock = null;
let hz = 20;
let timeOffset = 0;
let seq = 0;

let pending = null;     // ровно один кадр в полёте
let busy = false;
let dropped = 0;
let lastRun = 0;
let errors = 0;
let busyMs = 0;
const inferTimes = [];

const now = () => performance.now() + timeOffset;
const post = (msg, transfer) => self.postMessage(msg, transfer || []);

/* Закрывать кадр обязан каждый путь выхода. Утёкшие VideoFrame заставляют
   Chrome вообще перестать отдавать кадры с дорожки, и выглядит это как
   «игра зависла, а предпросмотр живой» — поломка, которую долго искать. */
function release(frame) {
  try { frame.close?.(); } catch { /* уже закрыт — не беда */ }
}

function kick() {
  if (busy || !pending || !landmarker) return;

  const frame = pending;
  pending = null;

  // Ограничение частоты — на месте отброса, а не очередью. Очередь означала
  // бы задержку, растущую без предела: кадры приходят каждые 33 мс, инференс
  // занимает 40, и разница копится.
  if (lastRun && performance.now() - lastRun < 1000 / hz) {
    release(frame);
    dropped++;
    return;
  }

  busy = true;
  lastRun = performance.now();
  const tCap = frame.timestamp != null ? frame.timestamp / 1000 : now();
  const t0 = performance.now();
  let lm = null;
  try {
    lm = pack.packLandmarks(landmarker.detectForVideo(frame, clock(now())));
    errors = 0;
  } catch (e) {
    errors++;
    post({ type: 'pose.error', stage: 'infer', name: e?.name || 'Error', message: String(e?.message || e), seq });
  } finally {
    release(frame);
    const dt = performance.now() - t0;
    busyMs += dt;
    inferTimes.push(dt);
    if (inferTimes.length > 100) inferTimes.shift();
    busy = false;
  }

  post({
    type: 'pose', seq: seq++, tCap, tDone: now(),
    inferMs: Math.round(performance.now() - t0), dropped, lm,
  }, lm ? [lm.buffer] : []);
  dropped = 0;

  if (errors >= 5) {
    post({ type: 'fail', stage: 'infer', message: 'пять ошибок инференса подряд' });
    errors = 0;
  }
  kick();
}

async function pump(readable) {
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (pending) { release(pending); dropped++; } // новейший вытесняет старый
    pending = value;
    kick();
  }
  post({ type: 'fail', stage: 'stream', message: 'поток кадров закончился' });
}

// Признак жизни раз в секунду: молчащий воркер иначе неотличим от
// работающего, у которого просто нет поз.
setInterval(() => {
  if (!landmarker) return;
  const sorted = [...inferTimes].sort((a, b) => a - b);
  post({
    type: 'beat',
    busyFrac: Math.min(1, busyMs / 1000),
    dropped,
    p50: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0,
    p95: sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)]) : 0,
  });
  busyMs = 0;
}, 1000);

async function init(msg) {
  hz = msg.hz || hz;
  // У воркера собственное начало отсчёта — момент его создания. Без поправки
  // каждая межпоточная метка смещена на задержку запуска воркера, и это
  // смещение выглядит в точности как задержка инференса.
  timeOffset = (msg.mainTimeOrigin ?? performance.timeOrigin) - performance.timeOrigin;

  pack = await import(msg.packUrl);

  importScripts(msg.bundleUrl); // кладёт глобаль Vision
  const { FilesetResolver, PoseLandmarker } = self.Vision;

  // Спрашиваем предикатом самой библиотеки: по нему она и решает, какой
  // файл попросить. Своя проверка могла бы с ним разойтись, и мы сказали бы
  // «всё хорошо», а она ушла бы за файлом, которого мы не клали.
  if (!await FilesetResolver.isSimdSupported()) {
    post({ type: 'fail', stage: 'wasm', message: 'устройство не поддерживает WASM SIMD' });
    return;
  }

  const t0 = performance.now();
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase);
  landmarker = await PoseLandmarker.createFromOptions(
    fileset,
    pack.landmarkerOptions({ model: msg.modelUrl, delegate: msg.delegate, pose: msg.pose }),
  );
  const initMs = Math.round(performance.now() - t0);

  clock = pack.makeClock();
  const warmupP50 = pack.warmup(landmarker, clock, msg.pose.warmupRuns);

  post({
    type: 'ready',
    mode: msg.mode,
    delegate: msg.delegate,
    initMs,
    warmupP50,
    // Больше порога — считает процессор, что бы ни было написано в ответе.
    looksLikeCpu: warmupP50 != null && warmupP50 > msg.pose.warmupCpuMs,
  });

  if (msg.stream) pump(msg.stream);
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      await init(msg);
    } catch (err) {
      post({ type: 'fail', stage: err?.stage || 'model', name: err?.name || 'Error', message: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    if (pending) { release(pending); dropped++; }
    pending = msg.bitmap;
    kick();
    return;
  }

  if (msg.type === 'config') { hz = msg.hz || hz; return; }

  if (msg.type === 'stop') {
    if (pending) { release(pending); pending = null; }
    try { landmarker?.close(); } catch {}
    landmarker = null;
    post({ type: 'stopped' });
  }
};
