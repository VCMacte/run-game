// Воркер распознавания: обмен сообщениями и насос кадров.
//
// Он намеренно не вычисляет ничего сверх инференса — ни нормализации, ни
// жестов. Отдаёт сырые 132 числа, и вся математика живёт на главном потоке в
// чистом модуле, который проверяется обычным скриптом node. Десять килобайт в
// секунду — не та цена, ради которой стоит терять проверяемость.

import { createEngine } from './pose.engine.js';

let engine = null;
let hz = 20;
let timeOffset = 0;   // поправка на разницу часов воркера и главного потока
let seq = 0;

// Ровно один кадр в полёте, и вытесняет всегда новейший.
let pending = null;
let busy = false;
let dropped = 0;
let lastRun = 0;
let errors = 0;
const inferTimes = [];
let busyMs = 0;

const now = () => performance.now() + timeOffset;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

/* Закрывать кадр обязан каждый путь выхода. Утёкшие VideoFrame заставляют
   Chrome вообще перестать отдавать кадры с дорожки, и выглядит это как
   «игра зависла, а предпросмотр живой» — одна из самых неприятных поломок
   для поиска. */
function release(frame) {
  try { frame.close?.(); } catch {}
}

function kick() {
  if (busy || !pending || !engine) return;

  // Ограничение частоты — на месте отброса, а не очередью. Очередь здесь
  // означала бы растущую без предела задержку: кадры приходят каждые 33 мс,
  // инференс занимает 40, и разница копится.
  const minGap = 1000 / hz;
  const frame = pending;
  pending = null;
  if (lastRun && performance.now() - lastRun < minGap) {
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
    lm = engine.infer(frame, now());
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

  if (errors >= 5) { post({ type: 'fail', stage: 'infer', message: 'подряд ошибки инференса' }); errors = 0; }
  kick();
}

async function pump(readable) {
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (pending) { release(pending); dropped++; }
    pending = value;
    kick();
  }
  post({ type: 'fail', stage: 'stream', message: 'поток кадров закончился' });
}

// Сводка раз в секунду — признак жизни. Молчащий воркер иначе неотличим от
// работающего, у которого просто нет поз.
setInterval(() => {
  if (!engine) return;
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

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    hz = msg.hz || hz;
    // У воркера собственное начало отсчёта — момент его создания. Без
    // поправки каждая межпоточная метка смещена на задержку запуска воркера,
    // и это смещение выглядит в точности как задержка инференса.
    timeOffset = (msg.mainTimeOrigin ?? performance.timeOrigin) - performance.timeOrigin;
    try {
      engine = await createEngine({ delegate: msg.delegate || 'GPU' });
      post({
        type: 'ready', mode: msg.mode, delegate: engine.delegate,
        initMs: engine.initMs, warmupP50: engine.warmupP50, looksLikeCpu: engine.looksLikeCpu,
      });
      if (msg.stream) pump(msg.stream);
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
    engine?.destroy();
    engine = null;
    post({ type: 'stopped' });
  }
};
