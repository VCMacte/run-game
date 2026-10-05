// Коридор от первого лица на Canvas2D.
//
// Персонажа на экране нет, поэтому понять «где я» ребёнку больше нечем, кроме
// самой панорамы: она едет вбок вместе с телом непрерывно и без задержки. Это
// и обратная связь, и то, что маскирует задержку трансляции — воспринимаемая
// задержка определяется первым видимым изменением, а не моментом, когда вид
// доехал.
//
// Три правила отрисовки, и все три — не вкусовые:
//   * фиксированный буфер 1280×720 и никакого DPR. Miracast всё равно
//     пережимает в 720p, рисовать выше — чистый нагрев GPU, который уже делят
//     распознавание и кодировщик;
//   * никаких теней, фильтров и градиентов в покадровом пути: на Adreno 619
//     это самые дорогие операции, а сжатие их всё равно съест;
//   * ощущение скорости несут поперечные линии пола. В первом лице с
//     минимумом текстур смотреть больше не на что, и без них кажется, что
//     стоишь на месте.

import { VIEW } from './config.js';
import { clamp } from './util.js';

const EYE = 1.2;          // высота глаз ребёнка, условных метров
const WALL = 2.6;         // высота стен
const HALF = VIEW.corridorWidth / 2;
const NEAR = 0.7;
const FOV = 75 * Math.PI / 180;

const COLORS = {
  sky: '#0b0d14',
  wallL: '#1b2237',
  wallR: '#161c2e',
  floor: '#223052',
  line: '#e8eeff',
  star: '#ffd34d',
  starDim: '#8a7430',
};

export function createView(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  canvas.width = VIEW.width;
  canvas.height = VIEW.height;

  const W = VIEW.width;
  const H = VIEW.height;
  const f = (W / 2) / Math.tan(FOV / 2);

  // Проекция точки мира на экран. camX — боковой уход взгляда, camY — высота
  // глаз (падает в приседе).
  function project(x, y, z, camX, camY) {
    const d = Math.max(z, 0.05);
    return { sx: W / 2 + (x - camX) * f / d, sy: H * 0.46 + (camY - y) * f / d, scale: f / d };
  }

  function quad(p1, p2, p3, p4, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(p1.sx, p1.sy);
    ctx.lineTo(p2.sx, p2.sy);
    ctx.lineTo(p3.sx, p3.sy);
    ctx.lineTo(p4.sx, p4.sy);
    ctx.closePath();
    ctx.fill();
  }

  return {
    get element() { return canvas; },

    /**
     * Один кадр.
     * `u` — боковое смещение тела в долях торса, `v` — присед, оба уже
     * сглажены и предсказаны: сюда приходит то, что надо показать сейчас.
     */
    render({ u = 0, v = 0, travel = 0, stars = [], dim = 0 }) {
      const camX = clamp(u, -1.5, 1.5) * VIEW.panGain * HALF;
      const camY = EYE * (1 - clamp(v, 0, 0.6) * VIEW.pitchGain);

      ctx.fillStyle = COLORS.sky;
      ctx.fillRect(0, 0, W, H);

      const far = VIEW.fogDistance;

      // Пол. Один четырёхугольник от ближнего края до тумана.
      quad(
        project(-HALF, 0, NEAR, camX, camY),
        project(HALF, 0, NEAR, camX, camY),
        project(HALF, 0, far, camX, camY),
        project(-HALF, 0, far, camX, camY),
        COLORS.floor,
      );

      // Стены. Разного тона: при боковом уходе взгляда разница в светлоте
      // подсказывает направление даже после сжатия, когда цвет уже размыт.
      quad(
        project(-HALF, 0, NEAR, camX, camY),
        project(-HALF, WALL, NEAR, camX, camY),
        project(-HALF, WALL, far, camX, camY),
        project(-HALF, 0, far, camX, camY),
        COLORS.wallL,
      );
      quad(
        project(HALF, 0, NEAR, camX, camY),
        project(HALF, WALL, NEAR, camX, camY),
        project(HALF, WALL, far, camX, camY),
        project(HALF, 0, far, camX, camY),
        COLORS.wallR,
      );

      // Поперечные линии пола. Они и есть скорость: без них в пустом коридоре
      // кажется, что стоишь на месте.
      const step = VIEW.floorLineStep;
      const phase = travel % step;
      ctx.fillStyle = COLORS.line;
      for (let z = NEAR + step - phase; z < far; z += step) {
        const thick = clamp(0.06 * (far - z) / far + 0.02, 0.02, 0.1);
        const a = project(-HALF, 0, z, camX, camY);
        const b = project(HALF, 0, z, camX, camY);
        const c = project(HALF, 0, z + thick, camX, camY);
        const d = project(-HALF, 0, z + thick, camX, camY);
        // Дальние линии бледнее, но не прозрачнее: прозрачность стоит дорого,
        // а разница в светлоте переживает сжатие лучше.
        ctx.fillStyle = z > far * 0.6 ? '#9fb0d8' : COLORS.line;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.lineTo(c.sx, c.sy);
        ctx.lineTo(d.sx, d.sy);
        ctx.closePath();
        ctx.fill();
      }

      // Звёзды. Квадратами, а не звёздочками: мелкая фигурная форма после
      // сжатия превращается в кашу, а крупный ромб читается.
      for (const s of stars) {
        const z = s.z - travel;
        if (z < NEAR || z > far) continue;
        const p = project(s.x, 1.0, z, camX, camY);
        const r = Math.max(3, p.scale * 0.16);
        ctx.fillStyle = s.taken ? COLORS.starDim : COLORS.star;
        ctx.beginPath();
        ctx.moveTo(p.sx, p.sy - r);
        ctx.lineTo(p.sx + r, p.sy);
        ctx.lineTo(p.sx, p.sy + r);
        ctx.lineTo(p.sx - r, p.sy);
        ctx.closePath();
        ctx.fill();
      }

      // Затемнение на паузе. Сплошной прямоугольник поверх — дешевле любого
      // фильтра и переживает сжатие.
      if (dim > 0) {
        ctx.fillStyle = `rgba(11,13,20,${clamp(dim, 0, 1)})`;
        ctx.fillRect(0, 0, W, H);
      }
    },
  };
}

/**
 * Раскладка звёзд.
 *
 * Висят в боковых третях коридора: главная ценность игры в том, что ребёнок
 * двигается, и собирать их, стоя посередине, не должно получаться.
 */
export function makeStars(count = 40, from = 6, step = 3.5) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    const side = i % 3 === 0 ? 0 : (i % 2 ? -1 : 1);
    stars.push({ x: side * HALF * 0.62, z: from + i * step, taken: false });
  }
  return stars;
}
