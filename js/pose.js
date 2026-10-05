// Источник поз: единственное место, где решается, откуда они берутся.
//
// Шов для синтетики ровно один — ветка в start(). Так сделано нарочно:
// тестовый путь не должен проникать в рабочий дальше одного условия, иначе
// проверяешь уже не то, что поедет на телефон.

import { POSE } from './config.js';
import { flag } from './util.js';
import { settings } from './settings.js';
import * as log from './log.js';

let active = null;

/**
 * Какой источник просили.
 *
 * Параметр адреса сильнее настройки: он задаётся осознанно и на один раз, а
 * настройка живёт между запусками и про неё легко забыть.
 */
export function wantedSource() {
  const fake = flag('fake');
  if (fake !== null) return { source: 'fake', script: fake || 'demo' };
  if (settings.get('debug') !== 'off') return { source: 'fake', script: 'demo' };
  return { source: 'camera' };
}

/**
 * Запускает поток поз. `onSample` получает записи вида
 * `{ seq, tCap, tDone, inferMs, dropped, lm }` — одинаковые для камеры и
 * синтетики.
 */
export async function start({ source, script, hz = POSE.hz, onSample, onStatus }) {
  await stop();

  if (source === 'fake') {
    const { createFakeSource } = await import('./fake-pose.js');
    active = createFakeSource({ script, hz, onSample });
    log.event('pose.source', { source: 'fake', script, hz });
    onStatus?.({ ready: true, source: 'fake', script, delegate: null });
    return active;
  }

  // Камера и MediaPipe подключаются по требованию: это семнадцать мегабайт,
  // и грузить их ради синтетического прогона незачем.
  const { createCameraSource } = await import('./pose.camera.js');
  active = await createCameraSource({ hz, onSample, onStatus });
  log.event('pose.source', { source: 'camera', hz, pipeline: active.pipeline });
  return active;
}

export async function stop() {
  if (!active) return;
  try { await active.stop(); } catch {}
  active = null;
}

export const current = () => active;
