// Звук игры.
//
// Это канал телеграфа, а не украшение, и самый быстрый из трёх. Звук идёт с
// динамика телефона, который стоит в двух-трёх метрах от ребёнка: доходит за
// восемь миллисекунд. Зеркалированный звук тащил бы на себе всю задержку
// трансляции, поэтому **телевизор приглушают**, а играет телефон.
//
// Мотивы различаются РИТМОМ, а не только высотой. Высоту съедает телефонный
// динамик, у которого низов нет, и комнатное эхо; а «два коротких», «два
// длинных» и «три подряд» различаются даже тогда, когда ребёнок смотрит в
// другую сторону. Именно это и нужно: за четыре секунды до препятствия звук
// должен сообщить не «что-то будет», а что именно делать.
//
// Синтез, а не файлы: десяток коротких сигналов не стоит ни одного килобайта
// в офлайн-кэше, где и так лежит семнадцать мегабайт MediaPipe.

import { settings } from './settings.js';

let ctx = null;
let master = null;

/** Контекст создаётся по жесту пользователя — раньше браузер его не пустит. */
export function wake() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Нота. `shape` различает тембры: мягкий для подсказок, жёсткий для событий.
 *
 * Атака и спад обязательны: обрыв волны даёт щелчок, который на маленьком
 * динамике слышен громче самой ноты.
 */
function note(at, freq, durS, gain, shape = 'triangle') {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = shape;
  osc.frequency.setValueAtTime(freq, at);
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, at + durS);
  osc.connect(env).connect(master);
  osc.start(at);
  osc.stop(at + durS + 0.03);
}

/* Мотивы: [частота, задержка от начала, длительность].

   Три предупреждающих устроены так, чтобы их нельзя было спутать даже
   невнимательно:
     влево   — два длинных, вниз;
     вправо  — два длинных, вверх;
     присед  — три коротких подряд, низко.
   Количество нот различается всегда, высота — дополнительно. */
const MOTIFS = {
  left: [[700, 0, 0.16], [466, 0.17, 0.2]],
  right: [[466, 0, 0.16], [700, 0.17, 0.2]],
  duck: [[233, 0, 0.09], [233, 0.1, 0.09], [175, 0.2, 0.16]],

  // Последний зов: короткое подтверждение, что стоишь правильно, или
  // предупреждение, что нет. Подтверждение не менее важно: в первом лице нет
  // персонажа, по которому видно, достаточно ли ты ушёл.
  ready: [[1050, 0, 0.07]],
  warn: [[370, 0, 0.07], [370, 0.09, 0.07]],

  clear: [[880, 0, 0.1]],
  star: [[1320, 0, 0.07]],

  // Задел. Нарочно негромкий и не резкий: ошибка стоит двух звёзд, пугать
  // ребёнка не за что.
  hit: [[190, 0, 0.1], [142, 0.09, 0.18]],

  // Финиш: короткая фанфара вверх. Единственное место, где звук длиннее
  // четверти секунды.
  finish: [[523, 0, 0.14], [659, 0.13, 0.14], [784, 0.26, 0.14], [1046, 0.39, 0.4]],

  countdown: [[700, 0, 0.08]],
  go: [[1046, 0, 0.22]],
};

/* Громкость по типу события. Подсказки должны быть слышны поверх всего, а
   звёзды — не забивать их: за забег их собирают десятками. */
const LEVEL = {
  left: 0.26, right: 0.26, duck: 0.26,
  warn: 0.22, ready: 0.12,
  clear: 0.14, star: 0.09, hit: 0.24,
  finish: 0.28, countdown: 0.18, go: 0.24,
};

export function play(name) {
  const vol = settings.get('sound') ?? 0.8;
  if (!vol) return;                 // «выключен» в родительском меню
  const c = wake();
  if (!c || c.state !== 'running') return;

  const motif = MOTIFS[name];
  if (!motif) return;
  const gain = vol * (LEVEL[name] ?? 0.2);
  const t0 = c.currentTime + 0.005;
  const shape = name === 'hit' ? 'sawtooth' : 'triangle';
  for (const [freq, offset, dur] of motif) note(t0 + offset, freq, dur, gain, shape);
}

/** Мотив для препятствия: что именно надо сделать. */
export const motifFor = (obstacle) =>
  (obstacle.kind === 'duck' ? 'duck' : obstacle.side > 0 ? 'left' : 'right');

/** Для проверок: сами мотивы. Не число нот — его мало, чтобы сравнить два. */
export const describe = () =>
  Object.fromEntries(Object.entries(MOTIFS).map(([k, v]) => [k, v.map((n) => [...n])]));
