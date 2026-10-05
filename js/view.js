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
import { VIEW, OBSTACLES as O, FINISH as FIN, SIGNALS as S } from './config.js';
import { clamp } from './util.js';
import { THEME, DECOR, MOTION, motionScale, rgba } from './theme.js';

const EYE = 1.2;          // высота глаз ребёнка, условных метров
const WALL = 2.6;         // высота стен
const HALF = VIEW.corridorWidth / 2;
const NEAR = 0.7;
const FOV = 75 * Math.PI / 180;

/* Палитра переехала в js/theme.js: там она проверяется по светлоте, и там же
   объяснено, почему проём почти белый, а облака подсинённые.

   Тема выбрана на уровне модуля, а не передаётся параметром. Второй темы не
   существует, и протаскивать её через восемь функций отрисовки ради будущей —
   та самая работа впрок, которой в этом проекте не делают. Выигрыш уже
   получен: цвета лежат в одном файле данных и проверяются машинно. */
const COLORS = THEME.greenHill;


/* Границы коридора наружу. Декорации и их проверки обязаны брать эти числа
   здесь, а не повторять у себя: разошедшиеся копии — это пальма, выросшая
   посреди игровой полосы, и заметно это станет на ребёнке. */
export const CORRIDOR_HALF = HALF;
export const CLIFF_TOP = WALL;

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

export function createView(canvas, { backdrop = null } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  canvas.width = VIEW.width;
  canvas.height = VIEW.height;

  /* «Меньше движения» спрашивается один раз на весь забег, а не каждый кадр:
     matchMedia в кадре — это обращение к стилям двадцать раз в секунду.
     Амплитуда сжимается почти в ноль, но код остаётся один: нулевой путь,
     который никто не исполняет, отдельно гниёт. */
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mscale = motionScale(reduced);

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
             elapsed = 0, safe = true, pulse = 0, finishIn = null, decor = [],
             speed = 0 }) {
      const cam = camera(u, v);

      const far = VIEW.fogDistance;

      // ── небо, дальние холмы, облака ──
      // В экранных координатах, а не через проекцию: они на бесконечности, и
      // проекция дала бы им нулевой размер. Параллакс здесь — разная скорость
      // слоёв, ровно как в комиксе того же автора.
      drawSky(ctx, cam, travel, elapsed, backdrop, mscale);

      // ── пол: шахматка ──
      drawFloor(ctx, cam, travel, { project, quad, far });

      // ── обрывы вместо стен ──
      // Геометрия та же, что была у стен, и трогать её нельзя: параллакс
      // ближнего поля — единственная обратная связь управления в игре.
      drawCliffs(cam, { project, quad, far });

      // ── декорации над кромкой ──
      drawDecor(ctx, cam, decor, travel, elapsed, { project, quad, far, mscale });

      // ── финиш ──
      // Рисуется до препятствий: ворота стоят дальше них и не должны лезть
      // поверх того, что ближе.
      if (finishIn != null && finishIn <= FIN.visibleS) {
        drawFinish(ctx, cam, Math.max(finishIn, 0) * VIEW.speed, { project, quad, pulse });
      }

      // ── препятствия и телеграф ──
      // Рисуются до звёзд: звезда перед препятствием должна быть видна
      // поверх него, иначе она теряется ровно там, где важна.
      /* «Стоит на месте» нужно бадникам: они икают, пока ребёнок не двигается.

         Считается по СКОРОСТИ, а не по положению. Через положение было
         наоборот: ребёнок, припарковавшийся в боковой трети, — ровно тот, кого
         икота должна расшевелить, — не видел её никогда, а пробегающий через
         центр видел. Порог берётся тот же, которым сигналы отличают дрейф от
         движения, чтобы «не двигается» значило одно и то же во всей игре. */
      const still = Math.abs(speed) < S.driftSpeedMax;
      drawObstacles(ctx, cam, obstacles, elapsed, { project, quad, far, safe, pulse, still, mscale });

      // ── кольца ──
      // Кольцо вместо звезды: ромб золота с тёмной серединой. Середина именно
      // заливкой, а не вырезом: тонкая рамка после сжатия исчезает, а тёмный
      // ромб внутри светлого читается как дырка и переживает Miracast.
      for (const s of stars) {
        const z = s.z - travel;
        if (z < NEAR || z > far) continue;
        const p = project(s.x, VIEW.starY, z, cam);
        const r = Math.max(3, p.scale * 0.16);

        // Собранное кольцо подпрыгивает и исчезает — короткой функцией от
        // времени, без хранения состояния.
        let lift = 0;
        if (s.taken) {
          const age = elapsed - (s.takenAtS ?? -9);
          if (age < 0 || age > 0.45) continue;
          lift = Math.sin((age / 0.45) * Math.PI) * r * 2.2 * mscale;
        }

        // Вращение: сжатие по горизонтали. В профиль кольцо не исчезает —
        // это цель, а не украшение.
        const w = r * ringSquash(elapsed, s.z, mscale);
        const cy = p.sy - lift;
        const ring = (rx, ry, fill) => {
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.moveTo(p.sx, cy - ry);
          ctx.lineTo(p.sx + rx, cy);
          ctx.lineTo(p.sx, cy + ry);
          ctx.lineTo(p.sx - rx, cy);
          ctx.closePath();
          ctx.fill();
        };
        ring(w, r, COLORS.star);
        if (w > 2.5) ring(w * 0.42, r * 0.42, COLORS.starDim);
      }

      // Затемнение на паузе. Сплошной прямоугольник поверх — дешевле любого
      // фильтра и переживает сжатие.
      if (dim > 0) {
        ctx.fillStyle = rgba(COLORS.shade, clamp(dim, 0, 1));
        ctx.fillRect(0, 0, W, H);
      }
    },
  };
}

/* ─────────────────────── слои фона ───────────────────────

   Небо и дальние холмы — единственное место, где уместен растр: мягкие
   градиенты и дымку вектором не нарисовать. Он необязателен — без него
   рисуются плоские полосы и силуэт холмов, и игра остаётся играбельной.
   Это важнее, чем кажется: арт собирается отдельным прогоном Easy Diffusion,
   и игра не должна от него зависеть.

   Контракт растра: ГОРИЗОНТ НА 46% ВЫСОТЫ картинки, потому что ровно там он у
   нашей проекции (HORIZON = H * 0.46). Фон с горизонтом в другом месте не
   сойдётся с полом, и стык будет виден сразу. */
function drawSky(ctx, cam, travel, elapsed, backdrop, mscale) {
  const hy = HORIZON + cam.pitch;

  ctx.fillStyle = COLORS.skyLow;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = COLORS.sky;
  ctx.fillRect(0, 0, W, Math.max(0, hy - H * 0.16));

  if (backdrop && backdrop.width) {
    // Растр тянется по ширине кадра и кладётся дважды: при боковом уходе
    // взгляда и своём параллаксе он иначе оторвался бы от края.
    const dh = W * backdrop.height / backdrop.width;
    const dy = hy - dh * 0.46;
    const shift = -(travel * MOTION.farParallax * 40 + cam.x * 30) % W;
    ctx.drawImage(backdrop, shift, dy, W, dh);
    ctx.drawImage(backdrop, shift + (shift > 0 ? -W : W), dy, W, dh);
    return;
  }

  // Запасной путь: силуэт холмов. Крупными горбами — мелкий рельеф после
  // сжатия всё равно превратится в кашу.
  ctx.fillStyle = COLORS.hills;
  const drift = travel * MOTION.farParallax * 18 + cam.x * 24;
  for (let i = -1; i < 7; i++) {
    const cx = ((i * 0.22 * W - drift) % (W * 1.6) + W * 1.6) % (W * 1.6) - W * 0.3;
    const rw = W * (0.17 + 0.05 * ((i + 7) % 3));
    const rh = H * (0.05 + 0.022 * ((i + 7) % 3));
    ctx.beginPath();
    ctx.moveTo(cx - rw, hy);
    ctx.quadraticCurveTo(cx, hy - rh * 2.2, cx + rw, hy);
    ctx.closePath();
    ctx.fill();
  }

  // Облака: своя скорость и свой дрейф. Подсинённые, а не белые — белое
  // облако у горизонта спорит по светлоте с проёмом.
  ctx.fillStyle = COLORS.cloud;
  const cd = travel * MOTION.cloudParallax * 22 + elapsed * MOTION.cloudDriftHz * 60 * mscale;
  for (let i = 0; i < 4; i++) {
    const cx = ((i * 0.31 * W - cd) % (W * 1.3) + W * 1.3) % (W * 1.3) - W * 0.15;
    const cy = hy - H * (0.2 + 0.07 * (i % 3));
    const rw = W * 0.085;
    const rh = H * 0.028;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + rw * 0.7, cy + rh * 0.3, rw * 0.6, rh * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* Пол шахматкой.

   Шаг тот же, что был у поперечных линий (floorLineStep), и это не мелочь:
   линии несли скорость и ритм, по которому ребёнок ждёт препятствие. Сменить
   шаг значило бы сменить ритм, то есть залезть в гейм-плей.

   Клетки привязаны к мировой сетке (z + travel), а не к фазе: привязанные к
   фазе они дёргались бы на каждом обороте остатка.

   Защита от мерцания у горизонта сохранена: то, что мельче lineMinGapPx, не
   рисуется вовсе. Это чистая резь в глазах без крупицы пользы. */
function drawFloor(ctx, cam, travel, { project, quad, far }) {
  const step = VIEW.floorLineStep;
  const NX = 4;                      // столбцов на ширину коридора
  const cw = (HALF * 2) / NX;

  // Основа одним четырёхугольником: половину клеток рисовать не надо.
  quad(
    project(-HALF, 0, NEAR, cam), project(HALF, 0, NEAR, cam),
    project(HALF, 0, far, cam), project(-HALF, 0, far, cam),
    COLORS.floorB,
  );

  const zStart = Math.ceil((NEAR + travel) / step) * step - travel;
  for (let zb = zStart; zb < far; zb += step) {
    if (F * step / (zb * zb) < VIEW.lineMinGapPx) break;
    const iz = Math.round((zb + travel) / step);
    const zf = Math.min(zb + step, far);
    // Дальние клетки бледнее, но не прозрачнее: прозрачность стоит дорого, а
    // разница в светлоте переживает сжатие лучше.
    const fill = zb > far * 0.45 ? COLORS.floorFar : COLORS.floorA;
    for (let ix = 0; ix < NX; ix++) {
      if ((iz + ix) % 2) continue;
      const x0 = -HALF + ix * cw;
      const x1 = x0 + cw;
      quad(
        project(x0, 0, zb, cam), project(x1, 0, zb, cam),
        project(x1, 0, zf, cam), project(x0, 0, zf, cam),
        fill,
      );
    }
  }
}

/* Обрывы по сторонам — те же вертикальные плоскости, что были стенами.

   Светлота левого и правого различается, как и раньше: при боковом уходе
   взгляда разница подсказывает направление даже после сжатия, когда цвет уже
   размыт. Поверх — полоса травы по кромке и тёмная полоса глубже: именно они
   делают из стены обрыв. */
function drawCliffs(cam, { project, quad, far }) {
  const cliff = (x, earth) => {
    quad(
      project(x, 0, NEAR, cam), project(x, WALL, NEAR, cam),
      project(x, WALL, far, cam), project(x, 0, far, cam),
      earth,
    );
    // Тёмная полоса у основания: глубина обрыва.
    quad(
      project(x, 0, NEAR, cam), project(x, 0.5, NEAR, cam),
      project(x, 0.5, far, cam), project(x, 0, far, cam),
      COLORS.earthDeep,
    );
    // Кромка травы. Две полосы — светлая сверху, тёмная под ней: один тон
    // после сжатия сливается с землёй.
    quad(
      project(x, WALL - 0.34, NEAR, cam), project(x, WALL, NEAR, cam),
      project(x, WALL, far, cam), project(x, WALL - 0.34, far, cam),
      COLORS.grassDark,
    );
    quad(
      project(x, WALL - 0.14, NEAR, cam), project(x, WALL, NEAR, cam),
      project(x, WALL, far, cam), project(x, WALL - 0.14, far, cam),
      COLORS.grass,
    );
  };
  cliff(-HALF, COLORS.earthL);
  cliff(HALF, COLORS.earthR);
}

/* Декорации.

   Рисуются после обрывов и только выше кромки: ниже их всё равно не видно,
   стены закрывают всё за собой.

   Потолок на число нарисованных — не перестраховка, а бюджет кадра:
   Snapdragon 695 уже отдаёт 62 мс медианы на инференс при цели 20 Гц, и кадр
   здесь дешевле не станет. Ближние важнее дальних, список упорядочен по
   глубине, поэтому достаточно прекратить на потолке. */
const DECOR_MAX = 12;

function drawDecor(ctx, cam, decor, travel, elapsed, { project, quad, far, mscale }) {
  /* Сначала отбираем ближние — на них бюджет, — а рисуем в обратном порядке,
     от дальних к ближним. Список от `makeDecor` идёт по возрастанию глубины,
     и рисование прямо по нему клало дальнюю пальму поверх ближней: тёмный
     ствол дальней перекрывал зелёную крону ближней. Две пальмы одной стороны
     на трёх и пяти метрах перекрываются на экране — видно сразу. */
  const near = [];
  for (const d of decor) {
    if (near.length >= DECOR_MAX) break;
    const z = d.z - travel;
    if (z < NEAR || z > far * 0.75) continue;
    near.push([d, z]);
  }

  for (let i = near.length - 1; i >= 0; i--) {
    const [d, z] = near[i];

    const base = d.y;                        // кромка обрыва
    const top = base + d.h;
    const sway = palmSway(elapsed, d.phase, mscale);

    if (d.kind === 'palm') {
      const w = 0.09;
      quad(
        project(d.x - w, base, z, cam), project(d.x + w, base, z, cam),
        project(d.x + w + sway, top, z, cam), project(d.x - w + sway, top, z, cam),
        COLORS.palmTrunk,
      );
      /* Крона: два боковых пера и одно вверх. Средним пером тут был тот же
         цикл по [-1, 0, 1], и при нуле все четыре угла схлопывались в одну
         точку — перо с нулевой площадью, которого никто никогда не видел.
         Вертикальное перо приходится задавать отдельно: у него своя ширина,
         а не нулевой размах. */
      const cx = d.x + sway;
      for (const dir of [-1, 1]) {
        quad(
          project(cx, top - 0.1, z, cam), project(cx + dir * 0.52, top + 0.1, z, cam),
          project(cx + dir * 0.58, top + 0.28, z, cam), project(cx, top + 0.22, z, cam),
          COLORS.palmLeaf,
        );
      }
      quad(
        project(cx - 0.12, top - 0.05, z, cam), project(cx + 0.12, top - 0.05, z, cam),
        project(cx + 0.16, top + 0.34, z, cam), project(cx - 0.16, top + 0.34, z, cam),
        COLORS.palmLeaf,
      );
    } else if (d.kind === 'bush') {
      quad(
        project(d.x - 0.34, base, z, cam), project(d.x + 0.34, base, z, cam),
        project(d.x + 0.26, top, z, cam), project(d.x - 0.26, top, z, cam),
        COLORS.palmLeaf,
      );
      quad(
        project(d.x - 0.18, top - 0.08, z, cam), project(d.x + 0.18, top - 0.08, z, cam),
        project(d.x + 0.12, top + 0.12, z, cam), project(d.x - 0.12, top + 0.12, z, cam),
        COLORS.grass,
      );
    } else if (d.kind === 'flower') {
      quad(
        project(d.x - 0.03, base, z, cam), project(d.x + 0.03, base, z, cam),
        project(d.x + 0.03, top, z, cam), project(d.x - 0.03, top, z, cam),
        COLORS.grassDark,
      );
      /* Цветок поворачивается вслед проходящему. Поворот — функция близости, а
         не времени: он должен провожать именно того, кто бежит. */
      const turn = clamp(1 - z / 6, 0, 1) * MOTION.flowerTurnM * mscale * -Math.sign(d.x);
      quad(
        project(d.x - 0.14 + turn, top, z, cam), project(d.x + 0.14 + turn, top, z, cam),
        project(d.x + 0.14 + turn, top + 0.28, z, cam), project(d.x - 0.14 + turn, top + 0.28, z, cam),
        COLORS.flower,
      );
    } else {
      // Тотем. Подмигивает, когда проходишь вплотную — одна из четырёх шуток
      // уровня, и единственная, которую можно не заметить.
      quad(
        project(d.x - 0.22, base, z, cam), project(d.x + 0.22, base, z, cam),
        project(d.x + 0.22, top, z, cam), project(d.x - 0.22, top, z, cam),
        COLORS.totem,
      );
      /* Порог 3.6 м, а не «вплотную». Декорации стоят за кромкой, на
         x = ±1.75, и ближе ~2.3 м тотем уже за краем кадра: шутка, которую
         нельзя увидеть, — это не шутка, а мёртвый код. */
      const wink = z < 3.6 && Math.sin(elapsed * 6 + d.phase * 9) > 0.4;
      const eyeH = wink ? 0.03 : 0.12;
      quad(
        project(d.x - 0.1, top - 0.3, z, cam), project(d.x + 0.1, top - 0.3, z, cam),
        project(d.x + 0.1, top - 0.3 + eyeH, z, cam), project(d.x - 0.1, top - 0.3 + eyeH, z, cam),
        COLORS.badnikEye,
      );
    }
  }
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
function drawObstacles(ctx, cam, obstacles, elapsed, { project, quad, far, safe, pulse, still, mscale }) {
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
      /* Цепей здесь нет, хотя по замыслу бревно должно было висеть на них.
         Вешать не на что: плита и так занимает всё от `duckHeight` до кромки
         обрыва, промежутка нет. Нарисованные цепи ложились прямо на её лицо
         двумя тёмными полосами поверх цвета, который сообщает решение, —
         шума больше, чем смысла. */
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

      /* Шипы по кромке плиты и бадник на закрытой стороне.

         Форма сообщает тему, светлота сообщает решение: плита осталась ровно
         той же по светлоте, проём — самым светлым местом кадра, а шипы и враг
         добавлены поверх. Нарушить этот порядок значит сделать красивый
         уровень, в котором непонятно, куда уходить. */
      drawSpikes(ob, z, cam, { project, quad, x0, x1 });
      drawBadnik(ob, dt, z, cam, elapsed, { project, quad, x0, x1, safe, still, mscale });
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

/* Шипы по верхней кромке плиты.

   Треугольниками, но крупными: мелкий зубец после сжатия превращается в
   неровную линию. Цвет металла светлее плиты и темнее проёма — он не
   участвует в решении и не имеет права спорить с ним по светлоте. */
function drawSpikes(ob, z, cam, { project, quad, x0, x1 }) {
  const n = 3;
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const a = x0 + i * w;
    const apex = project(a + w / 2, WALL + 0.26, z, cam);
    quad(
      project(a, WALL, z, cam), project(a + w, WALL, z, cam),
      apex, apex,
      COLORS.spike,
    );
  }
}

/* Бадник — жук на колёсике, сидит на закрытой стороне.

   Тело тёмное: враг обязан быть заметным, но не светлым, иначе он начнёт
   соперничать с проёмом, то есть с сообщением «иди сюда».

   Две шутки уровня живут здесь, и обе — функции времени, без состояния:

   1. Икает, пока ребёнок стоит на месте. Нужна не для смеха: неподвижность —
      это ровно то, чего игра не хочет, и дёргающийся враг тянет взгляд.
   2. На последней отметке телеграфа, если ребёнок уже в безопасном месте,
      бадник вскрывается и из него выскакивает зверёк. Это награда, и она
      приходит ДО столкновения, а не после: в момент прохода бадник уже за
      спиной, и там его не видно вовсе — проверено построением проекции.
*/
function drawBadnik(ob, dt, z, cam, elapsed, { project, quad, x0, x1, safe, still, mscale }) {
  const cx = (x0 + x1) / 2;
  const opened = dt <= O.lastCallS && safe;

  // Икота: короткий подскок, и только когда ребёнок не двигается.
  const hic = still && !opened
    ? Math.max(0, Math.sin(elapsed * (2 * Math.PI / MOTION.badnikHiccupS) * 3)) ** 8 * 0.1 * mscale
    : 0;

  const bodyY = 0.14 + hic;
  const bodyH = 0.3;

  if (opened) {
    // Вскрылся: две половинки разъехались. Чем ближе, тем шире — функция dt,
    // а не накопленное время.
    const open = clamp(1 - dt / O.lastCallS, 0, 1);
    for (const dir of [-1, 1]) {
      const hx = cx + dir * (0.1 + open * 0.22);
      quad(
        project(hx - 0.1, bodyY, z, cam), project(hx + 0.1, bodyY, z, cam),
        project(hx + 0.1, bodyY + bodyH * 0.7, z, cam), project(hx - 0.1, bodyY + bodyH * 0.7, z, cam),
        COLORS.badnik,
      );
    }
    /* Зверёк: выскакивает и убегает по кромке обрыва, спотыкаясь. Спотыкание
       — просадка в середине пути, тоже функция `open`. */
    const run = open;
    const sx = cx + Math.sign(ob.side || 1) * run * 0.5;
    const trip = Math.abs(run - 0.55) < 0.08 ? -0.08 : 0;
    const sy = bodyY + bodyH + run * 0.5 + Math.abs(Math.sin(run * 9)) * 0.1 + trip;
    quad(
      project(sx - 0.09, sy, z, cam), project(sx + 0.09, sy, z, cam),
      project(sx + 0.09, sy + 0.18, z, cam), project(sx - 0.09, sy + 0.18, z, cam),
      COLORS.critter,
    );
    return;
  }

  // Тело.
  quad(
    project(cx - 0.24, bodyY, z, cam), project(cx + 0.24, bodyY, z, cam),
    project(cx + 0.24, bodyY + bodyH, z, cam), project(cx - 0.24, bodyY + bodyH, z, cam),
    COLORS.badnik,
  );
  // Колёсико: крутится. Видно по полоске, которая ходит вверх-вниз, — сплошной
  // круг вращения не показывает вовсе.
  const spin = Math.sin(elapsed * 2 * Math.PI * MOTION.badnikWheelHz * mscale) * 0.05;
  quad(
    project(cx - 0.14, 0.02, z, cam), project(cx + 0.14, 0.02, z, cam),
    project(cx + 0.14, bodyY, z, cam), project(cx - 0.14, bodyY, z, cam),
    COLORS.earthDeep,
  );
  quad(
    project(cx - 0.08, 0.06 + spin, z, cam), project(cx + 0.08, 0.06 + spin, z, cam),
    project(cx + 0.08, 0.1 + spin, z, cam), project(cx - 0.08, 0.1 + spin, z, cam),
    COLORS.spike,
  );
  // Глаз. Маленький и светлый: на светлоту кадра не влияет, но без него враг
  // не читается как живой.
  quad(
    project(cx - 0.07, bodyY + bodyH * 0.55, z, cam), project(cx + 0.07, bodyY + bodyH * 0.55, z, cam),
    project(cx + 0.07, bodyY + bodyH * 0.85, z, cam), project(cx - 0.07, bodyY + bodyH * 0.85, z, cam),
    COLORS.badnikEye,
  );
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

  /* Табличка-указатель: самая заметная шутка уровня и прямая цитата из той
     игры, по которой уровень сделан. Крутится, а вплотную шлёпается лицом
     вверх.

     Сжатие по горизонтали, а не поворот сцены: поворот обошёлся бы матрицей,
     а сжатие — это та же функция, что крутит кольца.

     Стоит У КРАЯ, а не посередине. Посередине она закрывала проход сплошной
     заливкой того же цвета, что и ворота, и всё вместе читалось как жёлтая
     стена поперёк коридора — проверено на кадре через tools/frame.html.
     Вплотную не рисуется вовсе: на метре она занимает весь экран. */
  if (z < 1.2) return;

  const sx = HALF * 0.62;
  const flop = z < 2.2;
  const spin = flop ? 1 : Math.abs(Math.cos(2 * Math.PI * z * MOTION.signSpinHz / VIEW.speed));
  const bw = 0.26 * Math.max(0.14, spin);
  const by = flop ? 0.14 : 0.78;
  const bh = flop ? 0.12 : 0.44;
  // Столбик.
  quad(
    project(sx - 0.04, 0, z, cam), project(sx + 0.04, 0, z, cam),
    project(sx + 0.04, by + bh * 0.4, z, cam), project(sx - 0.04, by + bh * 0.4, z, cam),
    COLORS.finishDark,
  );
  // Рамка и поле таблички: без рамки она сливается с перекладиной ворот,
  // потому что цвет у них один и тот же — цвет финиша.
  quad(
    project(sx - bw, by, z, cam), project(sx + bw, by, z, cam),
    project(sx + bw, by + bh, z, cam), project(sx - bw, by + bh, z, cam),
    COLORS.finishDark,
  );
  quad(
    project(sx - bw * 0.78, by + bh * 0.14, z, cam), project(sx + bw * 0.78, by + bh * 0.14, z, cam),
    project(sx + bw * 0.78, by + bh * 0.86, z, cam), project(sx - bw * 0.78, by + bh * 0.86, z, cam),
    COLORS.finish,
  );
}

/* ─────────────────────── анимации ───────────────────────

   Все до единой — функции времени. Ни одна не копит состояние, и это не
   стилистическое предпочтение: источник поз идёт на 20 Гц, кадры проседают, и
   накопительная анимация расходится с картинкой тем сильнее, чем дольше
   забег. Функция от времени не расходится никогда.

   Побочная выгода: их видно из node. Проверка «анимации» в tests-control.mjs
   прогоняет их без браузера и канваса, как и всю остальную математику. */

/**
 * Сжатие кольца по горизонтали: оно крутится.
 *
 * `t` — секунды от старта забега, `phase` — своя фаза кольца, чтобы весь ряд
 * не крутился в унисон. Пол 0.12 важен: кольцо, повернувшееся строго в
 * профиль, исчезло бы, а это цель, а не украшение — ребёнок должен видеть,
 * куда тянуться.
 */
export function ringSquash(t, phase = 0, scale = 1) {
  const spin = Math.max(0.12, Math.abs(Math.cos(2 * Math.PI * (t * MOTION.ringSpinHz + phase))));
  // Сжатие уменьшается вместе с амплитудой: при «меньше движения» кольцо
  // почти не вращается, но тот же код продолжает работать.
  return 1 - scale * (1 - spin);
}

/** Качание пальмовой кроны, условных метров в сторону. Вокруг своего места. */
export function palmSway(t, phase = 0, scale = 1) {
  return MOTION.palmSwayM * scale * Math.sin(2 * Math.PI * (t * MOTION.palmSwayHz + phase));
}

/**
 * Декорации по сторонам коридора.
 *
 * Стоят ЗА кромкой обрыва и выше неё. Иначе никак: стены рисуются сплошными
 * четырёхугольниками до тумана и всё за собой закрывают.
 *
 * Расставляются по времени, а не через равные метры: при смене скорости бега
 * уровень должен выглядеть так же густо, а метры этого не дают.
 *
 * Ни одна декорация не участвует в игре — не меняет `isSafe`, не попадает в
 * игровую полосу, не даёт очков. Проверяется группой «декорации».
 */
export function makeDecor({ durationS = 300, rng = Math.random } = {}) {
  const total = DECOR.kinds.reduce((sum, k) => sum + k.weight, 0);
  const pick = (r) => {
    let acc = 0;
    for (const k of DECOR.kinds) {
      acc += k.weight / total;
      if (r < acc) return k;
    }
    return DECOR.kinds[DECOR.kinds.length - 1];
  };

  const out = [];
  let t = DECOR.firstS;
  while (t < durationS) {
    const side = rng() < 0.5 ? -1 : 1;
    const k = pick(rng());
    out.push({
      kind: k.kind,
      side,
      x: side * (HALF + DECOR.outM),
      y: WALL,                 // основание — ровно кромка обрыва
      h: k.height,
      z: t * VIEW.speed,
      at: t,
      phase: rng(),
    });
    // Разброс, но без провалов: равные промежутки превращают обочину в
    // штакетник, а слишком редкие — в пустое ущелье.
    t += DECOR.gapS * (0.75 + rng() * 0.5);
  }
  return out;
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
 *
 * Расставляются по ВРЕМЕНИ, а не через равные метры. Расстояние ничего не
 * говорит о том, успеет ли ребёнок: на переход из левого положения в правое
 * нужны секунды, и нужны они одни и те же при любой скорости бега. Поэтому
 * промежуток перед звездой на другой стороне больше — ровно на цену перехода.
 *
 * Три подряд на одной стороне не ставим: смысл игры в том, что ребёнок
 * двигается, а не стоит, подобрав удобное положение.
 */
export function makeStars({ durationS = 300, rng = Math.random } = {}) {
  // Сначала стороны, потом расстановка: промежуток перед звездой зависит от
  // того, придётся ли к ней переходить, то есть от следующей стороны.
  const sides = [];
  const n = Math.ceil(durationS / VIEW.starGapS) + 2;
  let sameRun = 0;
  for (let i = 0; i < n; i++) {
    let side = rng() < 0.3 ? 0 : (rng() < 0.5 ? -1 : 1);
    if (side !== 0 && side === sides[i - 1] && sameRun >= 1) side = -side;
    sameRun = side !== 0 && side === sides[i - 1] ? sameRun + 1 : 0;
    sides.push(side);
  }

  const stars = [];
  let t = VIEW.starFirstS;
  for (let i = 0; i < sides.length && t < durationS; i++) {
    stars.push({
      x: sides[i] * HALF * VIEW.starX,
      z: t * VIEW.speed,
      side: sides[i],
      at: t,
      taken: false,
    });
    const next = sides[i + 1];
    const переход = next !== undefined && next !== 0 && sides[i] !== 0 && next !== sides[i];
    t += переход ? VIEW.starSwitchS : VIEW.starGapS;
  }
  return stars;
}
