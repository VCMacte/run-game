// Синтетический ребёнок.
//
// Нужен не для красоты тестов. Путь «настоящая камера → MediaPipe» нельзя
// проверить нигде, кроме телефона: у браузера на машине разработки камеры
// нет. Всё, что происходит *после* распознавания — нормализация, жесты,
// панорама, пауза, журнал, — проверить можно, и проверять это на живом
// ребёнке по десять раз подряд было бы издевательством.
//
// Файл подключается только динамическим import() и только на localhost или по
// ?fake=, так что в опубликованной сборке он не разбирается вовсе. Запуск с
// ним пишет в журнал pose.source — чтобы ни один замер нельзя было потом
// принять за настоящий.

const TAU = Math.PI * 2;

/* Сценарии. Каждый — функция времени в секундах, возвращающая параметры тела:
   смещение вбок в долях кадра, присед, масштаб, поворот, видимость. */
export const SCRIPTS = {
  // Стоит. Проверяет, что в покое ничего не дёргается.
  still: () => ({}),

  // Качается из стороны в сторону — основной сценарий для панорамы.
  walk: (t) => ({ x: 0.5 + 0.10 * Math.sin(TAU * t * 0.3) }),

  // Резкий шаг в сторону и возврат: так выглядит настоящее уклонение.
  'step-left': (t) => ({ x: 0.5 + (t % 4 < 2 ? 0.11 : 0) }),
  'step-right': (t) => ({ x: 0.5 - (t % 4 < 2 ? 0.11 : 0) }),

  crouch: (t) => ({ crouch: t % 4 < 2 ? 0.5 : 0 }),

  // Уходит из кадра: должна сработать автопауза, а по возвращении — отсчёт.
  'leave-frame': (t) => (t % 10 < 5 ? {} : { vis: 0.1 }),

  // Поворачивается боком: плечи схлопываются, управление перестаёт быть
  // надёжным, и игра обязана это заметить.
  profile: (t) => (t % 8 < 4 ? {} : { profile: 0.15 }),

  // Дрожание распознавания. Панораму трясти не должно.
  jitter: (t) => ({ x: 0.5 + 0.004 * Math.sin(t * 60) }),

  // Медленный уход по комнате за полминуты: смотреть, как интегратор его
  // впитывает и как дорожка при этом не срабатывает.
  drift: (t) => ({ x: 0.5 + 0.12 * Math.min(1, t / 30) }),

  // Комбинированный: всё подряд, для беглой проверки глазами.
  demo: (t) => {
    const phase = Math.floor(t / 6) % 4;
    if (phase === 0) return { x: 0.5 + 0.10 * Math.sin(TAU * t * 0.3) };
    if (phase === 1) return { crouch: t % 3 < 1.5 ? 0.5 : 0 };
    if (phase === 2) return { x: 0.5 + (t % 3 < 1.5 ? 0.11 : -0.11) };
    return { vis: t % 6 < 3 ? 0.9 : 0.1 };
  },
};

/** Скелет в раскладке MediaPipe: 33 точки по четыре числа. */
export function fakeLandmarks({ x = 0.5, y = 0.45, scale = 0.2, crouch = 0, profile = 1, vis = 0.9 } = {}) {
  const lm = new Float32Array(33 * 4);
  const put = (i, px, py, v = vis) => {
    lm[i * 4] = px; lm[i * 4 + 1] = py; lm[i * 4 + 2] = 0; lm[i * 4 + 3] = v;
  };
  const k = scale / 0.2;
  const halfShoulder = 0.11 * k * profile;
  const halfHip = 0.08 * k * profile;
  const shoulderY = y + crouch * scale;
  const hipY = y + scale + crouch * scale;

  // Голова и лицо — модель их отдаёт, и пусть отдаёт: так запись синтетики
  // по форме не отличается от настоящей.
  for (let i = 0; i <= 10; i++) put(i, x + (i % 3 - 1) * 0.02 * k, shoulderY - 0.12 * k);

  put(11, x - halfShoulder, shoulderY);
  put(12, x + halfShoulder, shoulderY);
  put(13, x - halfShoulder - 0.03 * k, shoulderY + 0.12 * k);
  put(14, x + halfShoulder + 0.03 * k, shoulderY + 0.12 * k);
  for (let i = 15; i <= 22; i++) put(i, x + (i % 2 ? -1 : 1) * (halfShoulder + 0.05 * k), shoulderY + 0.22 * k);

  put(23, x - halfHip, hipY);
  put(24, x + halfHip, hipY);

  const bent = crouch > 0.2;
  const kneeY = hipY + scale * (bent ? 0.35 : 0.7);
  const kneeOut = bent ? 0.06 * k : 0;
  put(25, x - halfHip - kneeOut, kneeY);
  put(26, x + halfHip + kneeOut, kneeY);
  put(27, x - halfHip, hipY + scale * 1.4);
  put(28, x + halfHip, hipY + scale * 1.4);
  for (let i = 29; i <= 32; i++) put(i, x + (i % 2 ? -1 : 1) * halfHip, hipY + scale * 1.45);

  return lm;
}

/**
 * Источник поз, по форме неотличимый от настоящего: та же запись, тот же
 * путь. Производственный код об этом файле не знает ничего, кроме одного
 * условия в pose.js.
 */
export function createFakeSource({ script = 'demo', hz = 20, onSample }) {
  const fn = SCRIPTS[script] || SCRIPTS.demo;
  const t0 = performance.now();
  let seq = 0;
  let timer = 0;

  const tick = () => {
    const now = performance.now();
    const params = fn((now - t0) / 1000);
    // Низкая видимость — это «ребёнка не видно», и отдавать надо отсутствие
    // позы, а не скелет с плохими числами: именно так ведёт себя модель.
    const lm = (params.vis ?? 0.9) < 0.3 ? null : fakeLandmarks(params);
    onSample({ seq: seq++, tCap: now, tDone: now, inferMs: 0, dropped: 0, lm });
  };

  timer = setInterval(tick, 1000 / hz);
  tick();

  return {
    kind: 'fake',
    script,
    stop() { clearInterval(timer); },
  };
}
