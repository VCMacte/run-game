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

const W = VIEW.width;
const H = VIEW.height;
const F = (W / 2) / Math.tan(FOV / 2);
const HORIZON = H * 0.46;

/**
 * Положение взгляда при таком состоянии тела.
 *
 * `x`, `y` — где находятся глаза; `yaw`, `pitch` — куда они смотрят. Поворот
 * сделан сдвигом центра проекции, а не вращением сцены: так горизонт остаётся
 * строго горизонтальным по построению, а не по аккуратности. Крен — главный
 * источник укачивания, а непрерывная панорама на 55 дюймах и так риск.
 */
export function camera(u = 0, v = 0) {
  const un = clamp(u, -1.5, 1.5);
  const vn = clamp(v, 0, 0.6);
  return {
    x: un * VIEW.panGain * HALF,
    y: EYE * (1 - vn * VIEW.pitchGain),
    yaw: -un * VIEW.yawPx,
    pitch: (vn / 0.6) * VIEW.pitchPx,
  };
}

/** Проекция точки мира на экран. Чистая арифметика — проверяется в node. */
export function project(x, y, z, cam) {
  const d = Math.max(z, 0.05);
  return {
    sx: W / 2 + cam.yaw + (x - cam.x) * F / d,
    sy: HORIZON + cam.pitch + (cam.y - y) * F / d,
    scale: F / d,
  };
}

/** Куда уехала точка схода и где оказался горизонт. Для проверок и диагностики. */
export const vanishX = (cam) => W / 2 + cam.yaw;
export const horizonY = (cam) => HORIZON + cam.pitch;

export function createView(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  canvas.width = VIEW.width;
  canvas.height = VIEW.height;

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
      const cam = camera(u, v);

      ctx.fillStyle = COLORS.sky;
      ctx.fillRect(0, 0, W, H);

      const far = VIEW.fogDistance;

      // Пол. Один четырёхугольник от ближнего края до тумана.
      quad(
        project(-HALF, 0, NEAR, cam),
        project(HALF, 0, NEAR, cam),
        project(HALF, 0, far, cam),
        project(-HALF, 0, far, cam),
        COLORS.floor,
      );

      // Стены. Разного тона: при боковом уходе взгляда разница в светлоте
      // подсказывает направление даже после сжатия, когда цвет уже размыт.
      quad(
        project(-HALF, 0, NEAR, cam),
        project(-HALF, WALL, NEAR, cam),
        project(-HALF, WALL, far, cam),
        project(-HALF, 0, far, cam),
        COLORS.wallL,
      );
      quad(
        project(HALF, 0, NEAR, cam),
        project(HALF, WALL, NEAR, cam),
        project(HALF, WALL, far, cam),
        project(HALF, 0, far, cam),
        COLORS.wallR,
      );

      // Поперечные линии пола. Они и есть скорость: без них в пустом коридоре
      // кажется, что стоишь на месте.
      const step = VIEW.floorLineStep;
      const phase = travel % step;
      ctx.fillStyle = COLORS.line;
      for (let z = NEAR + step - phase; z < far; z += step) {
        const thick = clamp(0.06 * (far - z) / far + 0.02, 0.02, 0.1);
        const a = project(-HALF, 0, z, cam);
        const b = project(HALF, 0, z, cam);
        const c = project(HALF, 0, z + thick, cam);
        const d = project(-HALF, 0, z + thick, cam);
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
        const p = project(s.x, VIEW.starY, z, cam);
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
 * Где находятся глаза при таком смещении тела.
 *
 * Отдаётся наружу, чтобы сбор звёзд считался по тому же числу, по которому
 * рисуется картинка: две копии этой формулы разошлись бы, и звёзды начали бы
 * собираться не там, где их видно.
 */
export const cameraX = (u) => camera(u, 0).x;

/**
 * Дотянется ли ребёнок до звезды при таком смещении.
 *
 * Отдельной функцией, потому что это игровое правило, а не деталь
 * отрисовки: оно решает, надо ли вообще двигаться, чтобы собирать звёзды.
 * Проверяется в node.
 */
export const canReach = (starX, u) => Math.abs(starX - cameraX(u)) < VIEW.starReach;

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
    stars.push({ x: side * HALF * VIEW.starX, z: from + i * step, taken: false });
  }
  return stars;
}
