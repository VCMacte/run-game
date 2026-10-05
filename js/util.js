// Мелкие приёмы, нужные нескольким модулям.
//
// Отдельный файл понадобился не для красоты: камера и распознавание тоже
// должны уметь не ждать вечно, а импортировать их из app.js значило бы
// замкнуть круг camera → app → train → camera.

/**
 * Не ждать обещание дольше разумного.
 *
 * Обещания полного экрана, блокировки ориентации, разрешения камеры и
 * инициализации MediaPipe умеют не завершаться никогда. В комиксе на этом
 * приложение зависало на экране загрузки, и единственное лечение — срок.
 *
 * Возвращает `undefined` по истечении срока и при ошибке: вызывающий решает,
 * что значит отсутствие результата, и это всегда понятнее, чем исключение
 * из недр браузера.
 */
export function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(r, ms))]).catch(() => {});
}

/** То же, но отказом: нужно там, где молчание нельзя спутать с результатом. */
export function withDeadline(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: нет ответа ${ms} мс`)), ms)),
  ]);
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Линейная интерполяция. */
export const lerp = (a, b, t) => a + (b - a) * t;

export const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);

/** Параметры адреса: ?fake=walk, ?pipeline=bitmap — ручки для отладки. */
export const flag = (name) => new URLSearchParams(location.search).get(name);

/** Медиана и процентиль по небольшому массиву. Нужны для сводок здоровья. */
export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/** Округление для журнала: байты там дороже последних знаков. */
export const round = (x, digits = 2) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};
