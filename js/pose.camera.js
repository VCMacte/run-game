// Камера и распознавание: выбор конвейера и лестница отказов.
//
// Три пути доставки кадров до MediaPipe, по убыванию желательности:
//
//   stream — MediaStreamTrackProcessor, поток передаётся воркеру. Копий нет,
//            главный поток не делает на кадр ничего. Основной путь — но
//            наличие в Chrome для Android проверяется, а не предполагается.
//   bitmap — кадры снимаются на главном потоке и передаются воркеру. Стоит
//            копии и синхронизации GPU, то есть частично возвращает ту
//            работу, которую мы и выносили.
//   main   — инференс прямо на главном потоке, из цепочки setTimeout.
//            Последний запасной путь: синхронный блок на 35 мс ломает ритм
//            кадров, и на 55 дюймах это читается как задержка.
//
// Запасной путь, который проверяется только на телефоне ребёнка, — это
// запасной путь, который не работает. Поэтому любой из трёх включается
// принудительно через ?pipeline=.

import { POSE, VENDOR } from './config.js';
import { flag, withTimeout } from './util.js';
import { openCamera, watchTrack } from './camera.js';
import * as log from './log.js';

function probe() {
  return {
    mstp: typeof MediaStreamTrackProcessor !== 'undefined',
    offscreen: typeof OffscreenCanvas !== 'undefined',
    bitmap: typeof createImageBitmap === 'function',
    rvfc: typeof HTMLVideoElement !== 'undefined'
      && 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    worker: typeof Worker !== 'undefined',
  };
}

function choose(p) {
  const forced = flag('pipeline');
  if (forced && ['stream', 'bitmap', 'main'].includes(forced)) return forced;
  if (p.worker && p.mstp) return 'stream';
  if (p.worker && p.bitmap) return 'bitmap';
  return 'main';
}

export async function createCameraSource({ hz = POSE.hz, onSample, onStatus }) {
  const probes = probe();
  let mode = choose(probes);
  log.event('pose.boot', { pipeline: mode, probes, hzTarget: hz });

  const cam = await openCamera();
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = cam.stream;
  await withTimeout(video.play(), 5000);

  let stopped = false;
  let worker = null;
  let engine = null;
  let unwatch = watchTrack(cam.track, (why) => {
    onStatus?.({ error: `камера пропала (${why})` });
  });

  const emit = (sample) => { if (!stopped) onSample(sample); };

  async function startWorker(kind, delegate) {
    // Воркер классический, не модульный: MediaPipe выполняет свой
    // wasm-загрузчик через importScripts, которого в модульном воркере нет.
    // Проверено — там он падает с «ModuleFactory not set.».
    const w = new Worker(new URL('./pose.worker.js', import.meta.url));
    const ready = new Promise((resolve) => {
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { resolve(m); return; }
        if (m.type === 'fail') { resolve(m); return; }
        if (m.type === 'pose') { emit(m); return; }
        if (m.type === 'beat') { onStatus?.({ beat: m }); return; }
        if (m.type === 'pose.error') { log.event('pose.error', m); return; }
      };
      w.onerror = (e) => resolve({ type: 'fail', stage: 'worker', message: String(e.message || e) });
    });

    const init = {
      type: 'init', mode: kind, delegate, hz,
      mainTimeOrigin: performance.timeOrigin,
      bundleUrl: VENDOR.bundleClassic,
      packUrl: VENDOR.pack,
      wasmBase: VENDOR.wasmBase,
      modelUrl: VENDOR.model,
      pose: POSE,
    };
    if (kind === 'stream') {
      // Дорожка клонируется: оригинал остаётся на <video> для предпросмотра и
      // для запасного пути, и вопрос «можно ли одной дорожкой кормить и то и
      // другое» просто не возникает.
      const processor = new MediaStreamTrackProcessor({ track: cam.track.clone() });
      init.stream = processor.readable;
      w.postMessage(init, [processor.readable]);
    } else {
      w.postMessage(init);
    }

    const res = await withTimeout(ready, POSE.initTimeoutMs + 4000);
    if (!res || res.type !== 'ready') {
      w.terminate();
      return { ok: false, why: res?.message || 'нет ответа от воркера', stage: res?.stage };
    }
    return { ok: true, worker: w, info: res };
  }

  // ── лестница отказов ──
  // Каждая ступень пишется в журнал: иначе «почему-то медленно» невозможно
  // отличить от «GPU не завёлся и всё считается на процессоре».
  let info = null;
  for (const attempt of [
    { mode, delegate: 'GPU' },
    { mode, delegate: 'CPU' },
    { mode: 'bitmap', delegate: 'GPU' },
    { mode: 'main', delegate: 'GPU' },
  ]) {
    if (attempt.mode === 'main') break;
    const r = await startWorker(attempt.mode, attempt.delegate);
    if (r.ok) { worker = r.worker; mode = attempt.mode; info = r.info; break; }
    log.event('pose.pipeline.down', { from: attempt.mode, delegate: attempt.delegate, why: r.why, stage: r.stage });
  }

  let frameTimer = 0;

  if (!worker) {
    // Последний путь: считаем на главном потоке. Цепочкой setTimeout, а не из
    // requestAnimationFrame — синхронный блок внутри кадра превращает потерю
    // одного кадра в потерю двух.
    mode = 'main';
    const { createEngine } = await import('./pose.engine.js');
    engine = await createEngine({ delegate: 'GPU' }).catch(() => createEngine({ delegate: 'CPU' }));
    info = { delegate: engine.delegate, initMs: engine.initMs, warmupP50: engine.warmupP50 };
    let seq = 0;
    const step = () => {
      if (stopped) return;
      const t0 = performance.now();
      let lm = null;
      try { lm = engine.infer(video, performance.now()); }
      catch (e) { log.event('pose.error', { stage: 'infer', message: String(e?.message || e) }); }
      emit({ seq: seq++, tCap: t0, tDone: performance.now(), inferMs: performance.now() - t0, dropped: 0, lm });
      frameTimer = setTimeout(step, 1000 / POSE.hzMainThread);
    };
    step();
  } else if (mode === 'bitmap') {
    // Поток управления — подтверждение от воркера: новый кадр снимается
    // только после того, как предыдущий посчитан.
    let inFlight = false;
    const prev = worker.onmessage;
    worker.onmessage = (e) => {
      if (e.data.type === 'pose') inFlight = false;
      prev(e);
    };
    const grab = async () => {
      if (stopped) return;
      if (!inFlight && video.videoWidth) {
        inFlight = true;
        try {
          const bmp = await createImageBitmap(video);
          worker.postMessage({ type: 'frame', bitmap: bmp }, [bmp]);
        } catch { inFlight = false; }
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(grab);
      else frameTimer = setTimeout(grab, 1000 / hz);
    };
    grab();
  }

  log.event('pose.ready', {
    pipeline: mode,
    delegate: info?.delegate ?? null,
    initMs: info?.initMs ?? null,
    warmupP50: info?.warmupP50 ?? null,
    looksLikeCpu: info?.looksLikeCpu ?? null,
    cam: { w: cam.settings.width, h: cam.settings.height, fps: Math.round(cam.settings.frameRate || 0) },
  });
  onStatus?.({ ready: true, source: 'camera', pipeline: mode, ...info });

  return {
    kind: 'camera',
    pipeline: mode,
    video,
    settings: cam.settings,
    info,
    async stop() {
      stopped = true;
      clearTimeout(frameTimer);
      unwatch?.();
      if (worker) { worker.postMessage({ type: 'stop' }); setTimeout(() => worker.terminate(), 300); }
      engine?.destroy();
      cam.stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
