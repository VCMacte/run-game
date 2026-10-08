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
export async function openCamera({ attempt = 1, facing = 'user' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('камера недоступна: нужен защищённый контекст (https или localhost)');
  }

  let lastError = null;
  for (let rung = 0; rung < CAMERA.ladder.length; rung++) {
    const rungSpec = CAMERA.ladder[rung];
    // Последняя ступень — просто `true`, «хоть что-нибудь»: туда камеру уже
    // не подставить, и это нормально, отказ открыть камеру вовсе хуже.
    const video = rungSpec === true
      ? true
      : { ...rungSpec, facingMode: rung < 2 ? { ideal: facing } : facing };
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
        askFacing: facing,
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

/**
 * Отношение сторон кадра — то, по которому MediaPipe нормирует x и y.
 *
 * Истина здесь — КАДР, а не `getSettings()`. Второй забег 8 октября: камера
 * открылась через 91 мс после поворота экрана, и дорожка сообщила 360×640,
 * то есть портрет, — тогда как кадры шли по-прежнему 640×360. Отношение
 * сторон бралось один раз и именно из отчёта дорожки, поэтому горизонталь
 * сжалась в 3.2 раза: ширина плеч к торсу вышла 0.27 при пороге 0.45, и игра
 * встала на «повернись к телевизору» навсегда — ни одна поза её оттуда не
 * выводила, потому что дело было не в позе. Что врал отчёт, а не камера
 * повернулась, видно по длине торса: она меряется высотой кадра и осталась
 * прежней (0.38 против 0.35).
 *
 * Спрашивается по порядку убывания достоверности:
 *
 *   1. размер кадра, пришедший ВМЕСТЕ С ПОЗОЙ из воркера — тот самый кадр,
 *      по которому MediaPipe и нормировал точки, спорить тут не с чем;
 *   2. `<video>`: размер раскодированного кадра с учётом поворота дорожки —
 *      им кормится запасной конвейер «на главном потоке», где поза приходит
 *      без размера;
 *   3. `getSettings()` дорожки — последнее, потому что именно он и соврал.
 *      Но у синтетического источника нет ни кадра, ни видео, и там он единственный.
 */
export function frameAspect({ sample, video, settings } = {}) {
  const sw = sample?.w, sh = sample?.h;
  if (sw > 0 && sh > 0) return sw / sh;
  const w = video?.videoWidth, h = video?.videoHeight;
  if (w > 0 && h > 0) return w / h;
  return settings?.width && settings?.height ? settings.width / settings.height : 16 / 9;
}

/** Доля высоты кадра, которую занимает ребёнок — по ней наводят штатив. */
export function framing(settings, geometry) {
  if (!geometry) return { fill: 0, ok: false };
  /* Длина торса — примерно треть роста, отсюда и оценка заполнения кадра.

     Без зажима в единицу, хотя он здесь стоял. Зажим делал ветку «слишком
     близко» недостижимой: `fill > fillMax` при потолке 1.0 не выполнялось
     никогда, а показанные взрослому «100%» означали что угодно от ровно
     кадра до вдвое больше кадра. */
  const fill = geometry.S * 3;
  return {
    fill,
    ok: fill >= CAMERA.fillMin && fill <= CAMERA.fillMax,
    /* Подсказки были развёрнуты наоборот — и это не опечатка в тексте, а
       работающий дефект: заказчик с ребёнком подходили ближе, чтобы сузить
       игровое поле, а телефон просил отойти ещё дальше. Мало ребёнка в кадре
       (`fill` ниже низа) — значит он ДАЛЕКО, и подойти надо, а не отойти. */
    hint: fill < CAMERA.fillMin ? 'Подойдите ближе к телефону или поднимите его выше'
      : fill > CAMERA.fillMax ? 'Отойдите дальше или опустите телефон ниже' : 'Хорошо',
    aspect: settings?.width && settings?.height ? settings.width / settings.height : null,
  };
}
