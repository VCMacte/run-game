// Камера: открыть, выдать дорожку, честно рассказать, что телефон дал на
// самом деле.
//
// Просить одно, а получить другое — обычное дело: у телефона 108-мегапиксельный
// сенсор с биннингом, и что он отдаст Chrome, заранее не известно. Поэтому
// запрошенное и выданное всегда едут рядом и попадают в журнал: без этого
// «распознавание тормозит» невозможно отличить от «камера молча выдаёт 1080p».

import { CAMERA } from './config.js';
import { withTimeout } from './util.js';
import * as log from './log.js';

/**
 * Открывает камеру, спускаясь по лестнице требований.
 *
 * Последняя ступень — `true`, то есть «хоть что-нибудь»: отказ открыть камеру
 * вовсе хуже, чем неудобное разрешение, которое хотя бы видно в журнале.
 */
export async function openCamera({ attempt = 1 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('камера недоступна: нужен защищённый контекст (https или localhost)');
  }

  let lastError = null;
  for (let rung = 0; rung < CAMERA.ladder.length; rung++) {
    const video = CAMERA.ladder[rung];
    const t0 = performance.now();
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ video, audio: false }),
        CAMERA.openTimeoutMs,
      );
      // withTimeout отдаёт undefined и по сроку, и по ошибке: для нас это
      // одно и то же — камеры нет, пробуем ступень ниже.
      if (!stream) { lastError = new Error('нет ответа'); continue; }

      const track = stream.getVideoTracks()[0];
      const got = track.getSettings();
      log.event('cam.open', {
        n: attempt, rung,
        askW: video?.width?.ideal ?? null, askH: video?.height?.ideal ?? null,
        gotW: got.width, gotH: got.height, gotFps: Math.round(got.frameRate || 0),
        facing: got.facingMode || null,
        ms: Math.round(performance.now() - t0),
      });

      return { stream, track, settings: got, rung };
    } catch (e) {
      lastError = e;
      log.event('cam.fail', { rung, name: e?.name || 'Error', message: String(e?.message || e) });
    }
  }
  throw lastError || new Error('камеру открыть не удалось');
}

/**
 * Следит за тем, что дорожка жива.
 *
 * Android отбирает камеру на входящем звонке — это три строки кода и одна из
 * самых частых реальных поломок. Без них игра просто застывает, и причина
 * ниоткуда не видна.
 */
export function watchTrack(track, onLost) {
  const ended = () => { log.event('cam.ended', { why: 'ended' }); onLost?.('ended'); };
  const muted = () => { log.event('cam.ended', { why: 'muted' }); onLost?.('muted'); };
  track.addEventListener('ended', ended);
  track.addEventListener('mute', muted);
  return () => {
    track.removeEventListener('ended', ended);
    track.removeEventListener('mute', muted);
  };
}

/** Доля высоты кадра, которую занимает ребёнок — по ней наводят штатив. */
export function framing(settings, geometry) {
  if (!geometry) return { fill: 0, ok: false };
  // Длина торса — примерно треть роста, отсюда и оценка заполнения кадра.
  const fill = Math.min(1, geometry.S * 3);
  return {
    fill,
    ok: fill >= CAMERA.fillMin && fill <= CAMERA.fillMax,
    hint: fill < CAMERA.fillMin ? 'Отойдите дальше от телефона или опустите его ниже'
      : fill > CAMERA.fillMax ? 'Подойдите ближе или поднимите телефон' : 'Хорошо',
    aspect: settings?.width && settings?.height ? settings.width / settings.height : null,
  };
}
