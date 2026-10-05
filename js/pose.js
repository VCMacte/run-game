// Источник поз: единственное место, где решается, откуда они берутся.
//
// Шов для синтетики ровно один — ветка в start(). Так сделано нарочно:
// тестовый путь не должен проникать в рабочий дальше одного условия, иначе
// проверяешь уже не то, что поедет на телефон.

import { POSE } from './config.js';
import { isDev, flag } from './util.js';
import * as log from './log.js';

let active = null;

/** Какой источник просили: ?fake=walk на localhost, иначе камера. */
export function wantedSource() {
  const fake = flag('fake');
  if (fake !== null && (isDev || flag('fake') !== null)) {
    return { source: 'fake', script: fake || 'demo' };
  }
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

  // Камера и MediaPipe подключатся сюда следующим шагом, по требованию: это
  // семнадцать мегабайт, и грузить их ради синтетического прогона незачем.
  // Пока ветка недостижима — вызывающий проверяет источник заранее, — но
  // молчать она не должна.
  log.event('pose.source', { source: 'camera', ready: false });
  throw new Error('камера ещё не подключена');
}

export async function stop() {
  if (!active) return;
  try { await active.stop(); } catch {}
  active = null;
}

export const current = () => active;
