// Проверка, что MediaPipe действительно лежит на телефоне целиком.
//
// Семнадцать с половиной мегабайт по телефонной связи — самый вероятный отказ
// установки во всём проекте. Беда в том, как он проявляется: наполовину
// закэшированная модель не даёт ошибки сети, она даёт молчаливый abort внутри
// wasm при создании распознавателя. По симптому это неотличимо от дефекта
// кода, и разбираться можно долго.
//
// Поэтому перед запуском тренировки комплект проверяется явно, и при
// неполноте показывается честный экран «нужен интернет один раз» вместо
// попытки работать с тем, что есть.

import { VENDOR } from './config.js';
import { isDev } from './util.js';

/**
 * Проверяет наличие и размер каждого файла в офлайн-кэше.
 *
 * Размер берётся из заголовка закэшированного ответа, а не чтением тела:
 * читать ради проверки 17.5 МБ — значит каждый раз тратить то, что мы и
 * пытаемся сберечь.
 */
export async function checkVendor() {
  // На localhost service worker не регистрируется вовсе, файлы берутся с
  // диска, и проверять нечего.
  if (isDev) return { ok: true, skipped: 'разработка' };
  if (!self.caches) return { ok: true, skipped: 'нет Cache API' };

  const names = await caches.keys();
  const name = names.find((k) => k.startsWith('run-v'));
  if (!name) return { ok: true, skipped: 'кэш ещё не создан' };

  const cache = await caches.open(name);
  const missing = [];
  const wrongSize = [];

  for (const [path, bytes] of Object.entries(VENDOR.files)) {
    const hit = await cache.match(path);
    if (!hit) { missing.push(path); continue; }
    const len = Number(hit.headers.get('content-length'));
    // Заголовка может не быть — тогда сверять нечем, и это не повод кричать.
    if (Number.isFinite(len) && len > 0 && len !== bytes) {
      wrongSize.push({ path, want: bytes, got: len });
    }
  }

  return { ok: !missing.length && !wrongSize.length, cache: name, missing, wrongSize };
}

/**
 * Поддерживает ли устройство WASM SIMD.
 *
 * Спрашиваем саму библиотеку, а не свою проверку: загрузчик по этому же
 * предикату решает, попросить `vision_wasm_internal.js` или
 * `vision_wasm_nosimd_internal.js`. Своя проверка могла бы разойтись с его —
 * и тогда мы бы сказали «всё хорошо», а он ушёл бы за файлом, которого у нас
 * нет, и получил 404 офлайн, на телефоне ребёнка.
 */
export async function checkSimd() {
  try {
    const { FilesetResolver } = await import(VENDOR.bundle);
    return await FilesetResolver.isSimdSupported();
  } catch {
    return null; // не смогли спросить — решает вызывающий
  }
}
