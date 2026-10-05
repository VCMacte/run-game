// Общая часть распознавания: упаковка точек и защищённые часы.
//
// Вынесено отдельно, потому что этим пользуются два разных исполнителя —
// классический воркер и запасной путь на главном потоке, — а две копии
// разошлись бы. Воркер подтягивает этот файл динамическим import(): в
// классических воркерах он доступен, в отличие от статических import.

/**
 * Метка времени для MediaPipe: строго возрастающее целое число миллисекунд.
 *
 * Это не придирка к стилю. При нарушении монотонности MediaPipe валится
 * abort'ом внутри wasm, и распознаватель после этого мёртв навсегда — ни
 * ошибки наружу, ни возможности восстановиться. Поэтому счётчик защищён, а не
 * «обычно и так растёт».
 */
export function makeClock() {
  let last = -1;
  return (ms) => {
    const t = Math.max(last + 1, Math.round(ms));
    last = t;
    return t;
  };
}

/**
 * Результат MediaPipe → 132 числа: 33 точки по x, y, z и видимости.
 *
 * Плоский массив, а не объекты: он уходит в другой поток передачей буфера,
 * без копирования, и разбирается на той стороне обычной арифметикой.
 */
export function packLandmarks(result) {
  const pts = result?.landmarks?.[0];
  if (!pts || !pts.length) return null;
  const out = new Float32Array(33 * 4);
  for (let i = 0; i < 33 && i < pts.length; i++) {
    const p = pts[i];
    out[i * 4] = p.x;
    out[i * 4 + 1] = p.y;
    out[i * 4 + 2] = p.z ?? 0;
    // У разных версий признак называется по-разному — берём что есть, а не
    // то, что ожидаем: отсутствие поля дало бы нули и «ребёнка не видно».
    out[i * 4 + 3] = p.visibility ?? p.presence ?? 1;
  }
  return out;
}

/** Настройки распознавателя, одинаковые для обоих исполнителей. */
export function landmarkerOptions({ model, delegate, pose }) {
  return {
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO',
    numPoses: pose.numPoses,
    minPoseDetectionConfidence: pose.minPoseDetectionConfidence,
    minPosePresenceConfidence: pose.minPosePresenceConfidence,
    minTrackingConfidence: pose.minTrackingConfidence,
    outputSegmentationMasks: pose.outputSegmentationMasks,
  };
}

/**
 * Прогрев по пустому кадру.
 *
 * Нужен не для «разогрева», а по двум измеренным причинам. Первая: первый
 * инференс строит граф и занимает секунды — замерено 3.3 с против 18 мс у
 * последующих, и без прогрева игра вставала бы колом на старте. Вторая:
 * заявленный делегат умеет врать, и единственный честный ответ на вопрос
 * «это правда GPU?» — сколько инференс занимает на самом деле.
 */
export function warmup(landmarker, clock, runs) {
  try {
    const c = new OffscreenCanvas(256, 256);
    const cx = c.getContext('2d');
    cx.fillStyle = '#808080';
    cx.fillRect(0, 0, 256, 256);
    const bmp = c.transferToImageBitmap();
    const times = [];
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      landmarker.detectForVideo(bmp, clock(performance.now()));
      times.push(performance.now() - s);
    }
    bmp.close();
    times.sort((a, b) => a - b);
    // Медиана, а не среднее: первый вызов на порядки дольше остальных и
    // среднее испортил бы.
    return Math.round(times[Math.floor(times.length / 2)]);
  } catch {
    return null;
  }
}
