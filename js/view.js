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

// FIN, а не F: F здесь уже занято фокусным расстоянием.
import { VIEW, OBSTACLES as O, FINISH as FIN } from './config.js';
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

  // Препятствие и проём различаются и тоном, и светлотой. Только тоном
  // нельзя: H.264 режет цветность сильнее светлоты, а дальтонизм в семь лет
  // ещё не диагностирован.
  block: '#c2415a',
  blockDark: '#8e2d40',
  gap: '#4fd6a0',
  signal: '#ffb02e',
  rail: '#ffffff',
  finish: '#ffd34d',
  finishDark: '#b8912c',
};

const W = VIEW.width;
const H = VIEW.height;
const F = (W / 2) / Math.tan(FOV / 2);
const HORIZON = H * 0.46;

/**
 * Положение взгляда при таком состоянии тела.
 *
 * `x`, `y` — где находятся глаза; `yaw`, `pitch` — куда они смотрят.
 *
 * Поворот взгляда отключён (`VIEW.yawPx = 0`): движение несёт один только
 * боковой сдвиг, то есть параллакс — стены и пол едут мимо, а точка схода
 * стоит на месте. От поступательного движения укачивает слабее, чем от
 * поворота, и для ребёнка на 55 дюймах это решающее соображение.
 *
 * Механизм поворота оставлен: он сделан сдвигом центра проекции, а не
 * вращением сцены, и поэтому горизонт остаётся строго горизонтальным по
 * построению, а не по аккуратности. Крен запрещён в любом случае.
 */
export function camera(u = 0, v = 0) {
  // Мёртвая зона: в покое распознавание всё равно дрожит на сотые доли, и без
  // неё стены мелко шевелятся даже у неподвижного ребёнка.
  const dead = VIEW.viewDeadband;
  const squelch = (x) => (Math.abs(x) < dead ? 0 : x - Math.sign(x) * dead);
  const un = clamp(squelch(u), -1.5, 1.5);
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
    render({ u = 0, v = 0, travel = 0, stars = [], dim = 0, obstacles = [],
             elapsed = 0, safe = true, pulse = 0, finishIn = null }) {
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
        // У горизонта линии сходятся плотнее пикселя и начинают мерцать —
        // это чистая резь в глазах без единой крупицы пользы. Расстояние
        // между соседними линиями на экране ≈ F * step / z².
        if (F * step / (z * z) < VIEW.lineMinGapPx) break;
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

      // ── финиш ──
      // Рисуется до препятствий: ворота стоят дальше них и не должны лезть
      // поверх того, что ближе.
      if (finishIn != null && finishIn <= FIN.visibleS) {
        drawFinish(ctx, cam, Math.max(finishIn, 0) * VIEW.speed, { project, quad, pulse });
      }

      // ── препятствия и телеграф ──
      // Рисуются до звёзд: звезда перед препятствием должна быть видна
      // поверх него, иначе она теряется ровно там, где важна.
      drawObstacles(ctx, cam, obstacles, elapsed, { project, quad, far, safe, pulse });

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
 * Препятствия и четыре отметки телеграфа.
 *
 * Порядок отметок и их смысл — в config.OBSTACLES. Коротко: за четыре секунды
 * в глубине коридора загорается полоса на той стороне, которая будет закрыта;
 * за три проявляется само препятствие; за две по полу идёт линия, которая
 * дойдёт до игрока ровно вместе с ним; за секунду проём пульсирует, а
 * неверное положение подсвечивается.
 *
 * Самая важная из них — линия по полу. Семилетка плохо оценивает «сколько
 * осталось до того столба», но прекрасно ждёт, пока линия доедет до него:
 * задача оценки расстояния подменяется задачей ожидания ритма, а ритм в этом
 * возрасте уже освоен.
 */
function drawObstacles(ctx, cam, obstacles, elapsed, { project, quad, far, safe, pulse }) {
  const edge = obstacleEdge();
  for (const ob of obstacles) {
    if (ob.passed) continue;
    const dt = ob.at - elapsed;          // секунд до прихода
    if (dt > O.signalS) continue;
    const zRaw = dt * VIEW.speed;

    /* Отсечение по ближней плоскости. Без него препятствие, уехавшее за
       спину, проецируется с зажатой отрицательной глубиной и растягивается
       на весь экран — проверено, экран заливает целиком. Логика
       столкновения при этом продолжает работать: она живёт отдельно и
       смотрит на время, а не на пиксели. */
    if (zRaw + O.thickness < O.drawNearM) continue;
    const z = Math.max(zRaw, O.drawNearM);

    // Метка в глубине коридора: крупная заливка, а не рамка. Тонкий контур на
    // дальнем плане сжатие уничтожает первым.
    if (dt <= O.signalS && dt > O.visibleS) {
      const zf = far * 0.92;
      const h = 0.9;
      if (ob.kind === 'duck') {
        quad(
          project(-HALF, WALL, zf, cam), project(HALF, WALL, zf, cam),
          project(HALF, WALL - h, zf, cam), project(-HALF, WALL - h, zf, cam),
          COLORS.signal,
        );
      } else {
        const x0 = ob.side > 0 ? edge : -HALF;
        const x1 = ob.side > 0 ? HALF : -edge;
        quad(
          project(x0, 0, zf, cam), project(x1, 0, zf, cam),
          project(x1, WALL * 0.5, zf, cam), project(x0, WALL * 0.5, zf, cam),
          COLORS.signal,
        );
      }
    }

    if (dt > O.visibleS) continue;
    const zBack = Math.max(zRaw + O.thickness, O.drawNearM + 0.02);

    // Проём заливается ярким: ребёнку надо показать, куда идти, а не только
    // куда нельзя.
    if (ob.kind === 'duck') {
      quad(
        project(-HALF, WALL, z, cam), project(HALF, WALL, z, cam),
        project(HALF, O.duckHeight, z, cam), project(-HALF, O.duckHeight, z, cam),
        COLORS.block,
      );
      quad(
        project(-HALF, WALL, zBack, cam), project(HALF, WALL, zBack, cam),
        project(HALF, O.duckHeight, zBack, cam), project(-HALF, O.duckHeight, zBack, cam),
        COLORS.blockDark,
      );
      quad(
        project(-HALF, 0.02, z, cam), project(HALF, 0.02, z, cam),
        project(HALF, 0.02, zBack, cam), project(-HALF, 0.02, zBack, cam),
        COLORS.gap,
      );
    } else {
      const x0 = ob.side > 0 ? edge : -HALF;
      const x1 = ob.side > 0 ? HALF : -edge;
      quad(
        project(x0, 0, z, cam), project(x1, 0, z, cam),
        project(x1, WALL, z, cam), project(x0, WALL, z, cam),
        COLORS.block,
      );
      quad(
        project(x0, 0, zBack, cam), project(x1, 0, zBack, cam),
        project(x1, WALL, zBack, cam), project(x0, WALL, zBack, cam),
        COLORS.blockDark,
      );
      // Пол в проёме.
      const g0 = ob.side > 0 ? -HALF : edge;
      const g1 = ob.side > 0 ? -edge : HALF;
      quad(
        project(g0, 0.02, z, cam), project(g1, 0.02, z, cam),
        project(g1, 0.02, zBack, cam), project(g0, 0.02, zBack, cam),
        COLORS.gap,
      );
    }

    // Линия по полу, которая дойдёт вместе с препятствием.
    if (dt <= O.railS && dt > 0 && zRaw > NEAR) {
      quad(
        project(-HALF, 0.03, Math.max(zRaw - 0.12, NEAR), cam), project(HALF, 0.03, Math.max(zRaw - 0.12, NEAR), cam),
        project(HALF, 0.03, Math.max(zRaw, NEAR), cam), project(-HALF, 0.03, Math.max(zRaw, NEAR), cam),
        COLORS.rail,
      );
    }

    // Последний зов: если ребёнок не там, закрытая сторона наливается цветом.
    // Подтверждение правильного положения не менее важно, чем предупреждение:
    // в первом лице нет персонажа, по которому видно, достаточно ли ты ушёл.
    if (dt <= O.lastCallS && dt > 0 && pulse > 0.5) {
      const warn = safe ? COLORS.gap : COLORS.block;
      quad(
        project(-HALF, 0, 0.75, cam), project(HALF, 0, 0.75, cam),
        project(HALF, 0.08, 0.75, cam), project(-HALF, 0.08, 0.75, cam),
        warn,
      );
    }
  }
}

/**
 * Ворота финиша.
 *
 * Две стойки и перекладина, жёлтым — цветом звёзд, а не проёма: проём значит
 * «сюда можно», а ворота значат «всё, добежал», и путать эти два сообщения
 * нельзя. На подходе перекладина мигает: это единственное место в игре, где
 * мигание уместно — оно обещает конец, а не требует реакции.
 */
function drawFinish(ctx, cam, z, { project, quad, pulse }) {
  if (z < 0.4) return;
  const w = FIN.postWidth;
  const h = FIN.gateHeight;
  const post = (x0, x1) => quad(
    project(x0, 0, z, cam), project(x1, 0, z, cam),
    project(x1, h, z, cam), project(x0, h, z, cam),
    COLORS.finishDark,
  );
  post(-HALF, -HALF + w);
  post(HALF - w, HALF);
  quad(
    project(-HALF, h, z, cam), project(HALF, h, z, cam),
    project(HALF, h - w, z, cam), project(-HALF, h - w, z, cam),
    z < 10 && pulse > 0.5 ? COLORS.finish : COLORS.finishDark,
  );
}

/** Где кончается препятствие и начинается проём. Связано с ходом камеры. */
export const obstacleEdge = () => Math.abs(camera(1, 0).x) * O.blockFrac;

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
