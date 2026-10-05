// Окошко камеры во время игры: что видит камера и что из этого поняла игра.
//
// Нужно не для отладки, а ребёнку. Игровое поле — это кусок комнаты, который
// видит камера, и у него есть края, которых не видно ниоткуда. Пока ребёнок к
// ним не привык, он выходит за кадр, игра встаёт на паузу, и непонятно,
// почему. Окошко со скелетом и полоса положения дают эти края увидеть.
//
// Картинка зеркалится. Камера смотрит на ребёнка спереди, и без зеркала его
// шаг влево уезжал бы на окошке вправо — то есть окошко, поставленное ради
// понимания, добавляло бы путаницы. С зеркалом оно ведёт себя как зеркало.

import { SIGNALS as S } from './config.js';

/* Кого с кем соединять, чтобы получился человечек. Руки и ноги рисуются,
   хотя игра их не использует: ребёнок должен узнать в фигурке себя, иначе
   окошко не объясняет ничего. */
const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],       // торс
  [11, 13], [13, 15], [12, 14], [14, 16],       // руки
  [23, 25], [25, 27], [24, 26], [26, 28],       // ноги
];

const COLORS = {
  ok: '#39d98a',
  lost: '#ffb02e',
  joint: '#f2f5ff',
};

/**
 * Положение ребёнка на полосе игрового поля.
 *
 * Чистая функция: по горизонтальной координате в кадре отдаёт место на
 * полосе и признаки «у края» и «вышел». Зеркалит заодно — полоса читается
 * ребёнком, а не камерой.
 */
export function fieldPosition(cx, margin = S.edgeMargin) {
  if (cx == null) return { x: null, nearEdge: false, outside: true };
  const x = 1 - cx; // зеркало: право камеры — это лево ребёнка
  return {
    x,
    nearEdge: x < margin * 2 || x > 1 - margin * 2,
    outside: x < margin || x > 1 - margin,
  };
}

/**
 * Рисует скелет поверх видео.
 *
 * `lm` — те же 132 числа, что приходят от распознавания; `ok` — считает ли
 * игра, что ребёнка видно. Цветом показано именно это: зелёный — видит,
 * жёлтый — что-то не так, и тогда понятно, что пауза будет не «ни с того ни
 * с сего».
 */
export function drawSkeleton(canvas, lm, ok) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;

  const X = (i) => (1 - lm[i * 4]) * w; // то же зеркало, что и у видео
  const Y = (i) => lm[i * 4 + 1] * h;
  const V = (i) => lm[i * 4 + 3];

  ctx.lineWidth = Math.max(2, w * 0.016);
  ctx.lineCap = 'round';
  ctx.strokeStyle = ok ? COLORS.ok : COLORS.lost;

  for (const [a, b] of BONES) {
    // Точку, в которой модель не уверена, рисовать нельзя: она улетает в
    // случайное место, и фигурка выглядит сломанной, хотя всё в порядке.
    if (V(a) < 0.4 || V(b) < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(X(a), Y(a));
    ctx.lineTo(X(b), Y(b));
    ctx.stroke();
  }

  // Плечи и бёдра — те самые четыре точки, по которым игра считает всё
  // остальное. Их видно отдельно: если пропали они, пропало управление.
  ctx.fillStyle = COLORS.joint;
  const r = Math.max(2, w * 0.014);
  for (const i of [S.LM.lShoulder, S.LM.rShoulder, S.LM.lHip, S.LM.rHip]) {
    if (V(i) < 0.4) continue;
    ctx.beginPath();
    ctx.arc(X(i), Y(i), r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Двигает отметку на полосе поля и подсвечивает приближение к краю. */
export function updateField(strip, mark, cx) {
  const p = fieldPosition(cx);
  if (p.x == null) {
    strip.classList.add('lost');
    mark.hidden = true;
    return p;
  }
  mark.hidden = false;
  mark.style.left = `${(p.x * 100).toFixed(1)}%`;
  strip.classList.toggle('near', p.nearEdge && !p.outside);
  strip.classList.toggle('lost', p.outside);
  return p;
}
