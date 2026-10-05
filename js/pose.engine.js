// Распознавание на главном потоке — последний запасной путь.
//
// Используется, когда воркер недоступен или не завёлся. Здесь можно брать
// модульную сборку MediaPipe (.mjs) обычным import(): ограничение с
// importScripts касается только воркера.
//
// Общая с воркером часть — упаковка точек, защищённые часы, настройки и
// прогрев — живёт в pose.pack.js: две копии разошлись бы.

import { VENDOR, POSE } from './config.js';
import { makeClock, packLandmarks, landmarkerOptions, warmup } from './pose.pack.js';

export async function createEngine({ delegate = 'GPU' } = {}) {
  const { FilesetResolver, PoseLandmarker } = await import(VENDOR.bundle);

  const simd = await FilesetResolver.isSimdSupported();
  if (!simd) {
    const e = new Error('устройство не поддерживает WASM SIMD');
    e.stage = 'wasm';
    throw e;
  }

  const t0 = performance.now();
  const fileset = await FilesetResolver.forVisionTasks(VENDOR.wasmBase);
  const landmarker = await PoseLandmarker.createFromOptions(
    fileset,
    landmarkerOptions({ model: VENDOR.model, delegate, pose: POSE }),
  );
  const initMs = Math.round(performance.now() - t0);

  const clock = makeClock();
  const warmupP50 = warmup(landmarker, clock, POSE.warmupRuns);

  return {
    delegate,
    initMs,
    warmupP50,
    looksLikeCpu: warmupP50 != null && warmupP50 > POSE.warmupCpuMs,

    /** Одна поза: 132 числа или null. `frame` — видео, VideoFrame или ImageBitmap. */
    infer(frame, atMs) {
      return packLandmarks(landmarker.detectForVideo(frame, clock(atMs)));
    },

    destroy() {
      try { landmarker.close(); } catch {}
    },
  };
}
