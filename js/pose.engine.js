// Единственный файл, который знает про MediaPipe.
//
// Отделён от воркера нарочно: последний запасной путь считает позу прямо на
// главном потоке, и без этого разделения его пришлось бы писать копией всей
// обвязки. Здесь — только «создать, посчитать, разрушить».

import { VENDOR, POSE } from './config.js';

/* Метка времени обязана быть строго возрастающим целым числом миллисекунд.
   Это не придирка: при нарушении MediaPipe валится abort'ом внутри wasm, и
   распознаватель после этого мёртв навсегда — ни ошибки, ни восстановления.
   Поэтому счётчик защищён, а не «обычно и так растёт». */
function makeClock() {
  let last = -1;
  return (ms) => {
    const t = Math.max(last + 1, Math.round(ms));
    last = t;
    return t;
  };
}

/**
 * Создаёт распознаватель.
 *
 * Возвращает и сам объект, и честные сведения о том, что получилось: какой
 * делегат согласился и сколько миллисекунд занимает инференс на прогреве.
 * Второе важнее первого — заявленный делегат умеет врать.
 */
export async function createEngine({ delegate = 'GPU' } = {}) {
  const { FilesetResolver, PoseLandmarker } = await import(VENDOR.bundle);

  // Загрузчик сам достраивает имя wasm и без поддержки SIMD попросит
  // vision_wasm_nosimd_internal.js, которого мы не кладём. Спрашиваем его же
  // предикатом, чтобы наша проверка не разошлась с его выбором.
  const simd = await FilesetResolver.isSimdSupported();
  if (!simd) {
    const e = new Error('устройство не поддерживает WASM SIMD');
    e.stage = 'wasm';
    throw e;
  }

  const t0 = performance.now();
  const fileset = await FilesetResolver.forVisionTasks(VENDOR.wasmBase);
  const landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: VENDOR.model, delegate },
    runningMode: 'VIDEO',
    numPoses: POSE.numPoses,
    minPoseDetectionConfidence: POSE.minPoseDetectionConfidence,
    minPosePresenceConfidence: POSE.minPosePresenceConfidence,
    minTrackingConfidence: POSE.minTrackingConfidence,
    outputSegmentationMasks: POSE.outputSegmentationMasks,
  });
  const initMs = Math.round(performance.now() - t0);

  const clock = makeClock();

  /* Прогрев по пустому кадру. Нужен не для разогрева, а как измерение:
     заявленный делегат может сказать GPU, считая на CPU, и единственный
     честный ответ — сколько это на самом деле занимает. */
  let warmupP50 = null;
  try {
    const blank = new OffscreenCanvas(64, 64);
    blank.getContext('2d').fillRect(0, 0, 64, 64);
    const bitmap = blank.transferToImageBitmap();
    const times = [];
    for (let i = 0; i < POSE.warmupRuns; i++) {
      const s = performance.now();
      landmarker.detectForVideo(bitmap, clock(performance.now()));
      times.push(performance.now() - s);
    }
    bitmap.close();
    times.sort((a, b) => a - b);
    warmupP50 = Math.round(times[Math.floor(times.length / 2)]);
  } catch {
    // Прогрев не получился — это само по себе не повод не играть.
  }

  return {
    delegate,
    initMs,
    warmupP50,
    // Больше порога — считает CPU, что бы ни было написано в ответе.
    looksLikeCpu: warmupP50 != null && warmupP50 > POSE.warmupCpuMs,

    /**
     * Одна поза. `frame` — VideoFrame или ImageBitmap.
     * Возвращает 132 числа (33 точки по x, y, z, видимость) или null.
     */
    infer(frame, atMs) {
      const res = landmarker.detectForVideo(frame, clock(atMs));
      const pts = res?.landmarks?.[0];
      if (!pts || !pts.length) return null;
      const out = new Float32Array(33 * 4);
      for (let i = 0; i < 33 && i < pts.length; i++) {
        const p = pts[i];
        out[i * 4] = p.x;
        out[i * 4 + 1] = p.y;
        out[i * 4 + 2] = p.z ?? 0;
        // У разных версий признак называется по-разному; берём что есть.
        out[i * 4 + 3] = p.visibility ?? p.presence ?? 1;
      }
      return out;
    },

    destroy() {
      try { landmarker.close(); } catch {}
    },
  };
}
