// Звук игры.
//
// Он здесь не украшение, а канал телеграфа — самый быстрый из трёх. Звук идёт
// с динамика телефона, который стоит в двух-трёх метрах от ребёнка: доходит
// за восемь миллисекунд. Зеркалированный звук тащил бы на себе всю задержку
// трансляции, поэтому **телевизор приглушают**, а играет телефон.
//
// Мотивов три, и они разные не для красоты: за четыре секунды до препятствия
// звук сообщает не «что-то будет», а что именно делать. Ребёнок начинает
// двигаться, ещё не разобрав картинку, и это снимает с бюджета задержки те
// самые полсекунды на «заметить».
//
// Синтез, а не файлы: четыре коротких сигнала не стоят ни одного килобайта в
// офлайн-кэше, где и так лежит семнадцать мегабайт MediaPipe.

import { settings } from './settings.js';

let ctx = null;

/** Контекст создаётся по жесту пользователя — раньше браузер его не пустит. */
export function wake() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/* Короткая нота. Треугольная волна: мягче пилы, но слышнее синуса на
   телефонном динамике, у которого низов нет вовсе. */
function note(at, freq, durS, gain) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, at);
  // Атака и спад: щелчок на обрыве раздражает сильнее самой ноты.
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, at + durS);
  osc.connect(env).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + durS + 0.02);
}

const VOLUME = () => settings.get('sound') ?? 0.8;

/* Мотивы. Разводятся направлением хода высоты, а не тембром: после
   телефонного динамика и комнатного эха тембр различается плохо, а «вверх
   или вниз» слышно всегда. */
const MOTIFS = {
  // Уходить влево — мотив идёт вниз.
  left: [[660, 0], [440, 0.11]],
  // Вправо — вверх.
  right: [[440, 0], [660, 0.11]],
  // Присед — низко и коротко, ни на что не похоже.
  duck: [[220, 0], [165, 0.1]],
  // Прошёл чисто.
  clear: [[880, 0]],
  // Задел. Не резкий: пугать не за что, ошибка ничего не стоит.
  hit: [[180, 0], [140, 0.08]],
  star: [[1320, 0]],
};

export function play(name) {
  const c = wake();
  if (!c) return;
  const motif = MOTIFS[name];
  if (!motif) return;
  const base = VOLUME() * (name === 'star' ? 0.12 : 0.22);
  const t0 = c.currentTime + 0.005;
  for (const [freq, offset] of motif) note(t0 + offset, freq, 0.13, base);
}

/** Мотив для препятствия: что именно надо сделать. */
export const motifFor = (obstacle) =>
  (obstacle.kind === 'duck' ? 'duck' : obstacle.side > 0 ? 'left' : 'right');
