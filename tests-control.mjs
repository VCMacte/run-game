// Проверки управления: математика сигналов и автомат калибровки.
//
//   node tests-control.mjs
//
// Всё здесь работает без браузера, камеры и ребёнка — ровно ради этого воркер
// не вычисляет ничего, а отдаёт сырые точки. Прогоном в браузере проверяется
// ощущение; проверить им таблицу истинности приседа невозможно.

import { makeTracker, makeOneEuro, geometry, makeFollower } from './js/signals.js';
import { makeCalibration, STAGES, CLAMP, isStale } from './js/calibrate.js';
import { SIGNALS as S, VIEW } from './js/config.js';
import { camera, project, vanishX, horizonY, cameraX, canReach, makeStars } from './js/view.js';
import { SCRIPTS, fakeLandmarks } from './js/fake-pose.js';
import { fieldPosition } from './js/preview.js';
import { makeLevel, telegraph, isSafe } from './js/level.js';
import { obstacleEdge } from './js/view.js';
import { OBSTACLES as O } from './js/config.js';

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ПРОВАЛ  ${name}${detail ? '\n          ' + detail : ''}`);
}
function group(name, fn) { console.log(name); return fn(); }

// ───────────────────── синтетический скелет ─────────────────────

/* Стоящий человек в нормализованных координатах кадра: x вправо, y вниз.
   Параметрами двигаем то, что нас интересует: смещение вбок, присед, подход
   к камере, поворот боком. */
function pose({ x = 0.5, y = 0.45, scale = 0.2, crouch = 0, profile = 1, vis = 0.9 } = {}) {
  const lm = new Float32Array(33 * 4);
  const put = (i, px, py, v = vis) => {
    lm[i * 4] = px; lm[i * 4 + 1] = py; lm[i * 4 + 2] = 0; lm[i * 4 + 3] = v;
  };
  const halfShoulder = 0.11 * scale / 0.2 * profile;
  const halfHip = 0.08 * scale / 0.2 * profile;
  // Присед: плечи и бёдра идут вниз, торс не укорачивается.
  const shoulderY = y + crouch * scale;
  const hipY = y + scale + crouch * scale;
  put(11, x - halfShoulder, shoulderY);
  put(12, x + halfShoulder, shoulderY);
  put(23, x - halfHip, hipY);
  put(24, x + halfHip, hipY);
  // Колени и ступни: в приседе колено сгибается.
  const kneeY = hipY + scale * (crouch > 0.2 ? 0.35 : 0.7);
  const kneeX = crouch > 0.2 ? 0.06 * scale / 0.2 : 0;
  put(25, x - halfHip - kneeX, kneeY);
  put(26, x + halfHip + kneeX, kneeY);
  put(27, x - halfHip, hipY + scale * 1.4);
  put(28, x + halfHip, hipY + scale * 1.4);
  return lm;
}

/** Прогнать серию поз через трекер с шагом dt мс. */
function run(tracker, frames, { dt = 50, t0 = 0 } = {}) {
  const out = [];
  let t = t0;
  for (const f of frames) {
    out.push(tracker.push({ lm: f, t }));
    t += dt;
  }
  return out;
}

const steady = (opts, n) => Array.from({ length: n }, () => pose(opts));

// ─────────────────────────── геометрия ───────────────────────────

group('геометрия', () => {
  const g = geometry(pose({ x: 0.5, scale: 0.2 }));
  check('длина торса положительна', g.S > 0);
  check('длина торса равна масштабу', Math.abs(g.S - 0.2) < 1e-6, `получилось ${g.S}`);
  check('центр тела по X найден', Math.abs(g.cx - 0.5) < 1e-6);

  // Ширина плеч схлопывается в профиль — именно поэтому она детектор
  // поворота, а не единица масштаба.
  const front = geometry(pose({ profile: 1 }));
  const side = geometry(pose({ profile: 0.2 }));
  check('масштаб не зависит от поворота', Math.abs(front.S - side.S) < 1e-6);
  check('поворот виден по отношению плеч к торсу', side.shoulderRatio < front.shoulderRatio / 3);

  // Та же поза вдвое дальше: все производные величины обязаны совпасть.
  const near = geometry(pose({ scale: 0.3 }));
  const far = geometry(pose({ scale: 0.15 }));
  check('отношение плеч к торсу не зависит от расстояния',
    Math.abs(near.shoulderRatio - far.shoulderRatio) < 1e-6);
});

// ──────────────────────── знак и расстояние ────────────────────────

group('знак и расстояние', () => {
  // Самая важная проверка файла. Задняя камера смотрит на ребёнка, повёрнутого
  // к ней лицом: когда он шагает в свою левую сторону, в кадре он уезжает
  // вправо. Перепутанный знак делает игру неиграбельной, и ловится он только
  // так — на живом ребёнке это выглядит как «игра сошла с ума».
  const tr = makeTracker();
  run(tr, steady({ x: 0.5 }, 5));
  const left = run(tr, steady({ x: 0.62 }, 5)).pop();
  check('шаг ребёнка влево даёт отрицательный u', left.uRaw < 0,
    `uRaw = ${left.uRaw?.toFixed(3)}; в кадре он смещается вправо`);

  const tr2 = makeTracker();
  run(tr2, steady({ x: 0.5 }, 5));
  const right = run(tr2, steady({ x: 0.38 }, 5)).pop();
  check('шаг ребёнка вправо даёт положительный u', right.uRaw > 0);

  // Одно и то же смещение «в долях тела» с разных дистанций должно читаться
  // одинаково: ради этого всё и меряется в длинах торса.
  const far = makeTracker();
  run(far, steady({ x: 0.5, scale: 0.15 }, 5));
  const farStep = run(far, steady({ x: 0.5 + 0.09, scale: 0.15 }, 5)).pop();
  const near = makeTracker();
  run(near, steady({ x: 0.5, scale: 0.30 }, 5));
  const nearStep = run(near, steady({ x: 0.5 + 0.18, scale: 0.30 }, 5)).pop();
  check('одинаковый шаг в долях тела читается одинаково с разных дистанций',
    Math.abs(farStep.uRaw - nearStep.uRaw) < 0.02,
    `далеко ${farStep.uRaw.toFixed(3)}, близко ${nearStep.uRaw.toFixed(3)}`);
});

// ─────────────────────────── One-Euro ───────────────────────────

group('One-Euro', () => {
  const f = makeOneEuro(S.oneEuro);
  for (let i = 0; i < 20; i++) f.push(0, 0.05);
  const first = f.push(1, 0.05);
  check('скачок не проходит мгновенно', first < 0.9, `сразу дало ${first.toFixed(3)}`);
  let last = first;
  for (let i = 0; i < 20; i++) last = f.push(1, 0.05);
  check('за 20 отсчётов догоняет', last > 0.95, `догнало до ${last.toFixed(3)}`);

  // Фильтр обязан шагать настоящим dt. Если подставлять ожидаемые 50 мс,
  // адаптация врёт ровно тогда, когда конвейер запнулся, — то есть когда она
  // и нужна.
  const a = makeOneEuro(S.oneEuro);
  const b = makeOneEuro(S.oneEuro);
  a.push(0, 0.05); b.push(0, 0.05);
  const fast = a.push(1, 0.01);
  const slow = b.push(1, 0.20);
  check('результат зависит от реального dt', Math.abs(fast - slow) > 0.05,
    `при dt=10мс ${fast.toFixed(3)}, при dt=200мс ${slow.toFixed(3)}`);

  const z = makeOneEuro(S.oneEuro);
  check('нулевой dt не ломает фильтр', Number.isFinite(z.push(0.5, 0)));
});

// ───────────────────────── дорожка ─────────────────────────

group('дорожка', () => {
  const tr = makeTracker();
  run(tr, steady({ x: 0.5 }, 10));
  check('в покое дорожка центральная', tr.lane === 0);

  run(tr, steady({ x: 0.5 - 0.16 }, 20)); // ребёнок ушёл вправо (в кадре влево)
  check('уверенное смещение переключает дорожку', tr.lane === 1, `lane = ${tr.lane}`);

  run(tr, steady({ x: 0.5 }, 20));
  check('возврат в центр возвращает дорожку', tr.lane === 0);

  // Дребезг ровно на пороге: стоять на границе и не метаться — требование не
  // косметическое, иначе персонаж трясётся между дорожками.
  const edge = makeTracker();
  run(edge, steady({ x: 0.5 }, 10));
  const onThreshold = 0.5 - S.uEnter * 0.2 * 1.0; // u ≈ uEnter
  let flips = 0;
  let prev = edge.lane;
  for (let i = 0; i < 60; i++) {
    const jitter = (i % 2 ? 1 : -1) * 0.0015;
    edge.push({ lm: pose({ x: onThreshold + jitter }), t: 1000 + i * 50 });
    if (edge.lane !== prev) { flips++; prev = edge.lane; }
  }
  check('на пороге дорожка не дребезжит', flips <= 1, `переключений: ${flips}`);
});

// ───────────────────────── присед ─────────────────────────

group('присед', () => {
  const tr = makeTracker();
  run(tr, steady({}, 10));
  check('стоя приседа нет', tr.crouch === false);

  run(tr, steady({ crouch: 0.5 }, 10));
  check('присед распознан', tr.crouch === true);

  // Минимальное удержание: короткий нырок не должен мигать.
  const held = run(tr, steady({ crouch: 0 }, 4)).pop();
  check('присед держится минимальное время', tr.crouch === true,
    `отпустило через ${held.t - 0} мс`);
  run(tr, steady({ crouch: 0 }, 20));
  check('потом отпускает', tr.crouch === false);

  // Главная ложная тревога: ребёнок подошёл к камере. Он стал крупнее, плечи
  // в кадре опустились — но это не присед.
  const near = makeTracker();
  run(near, steady({ scale: 0.20 }, 10));
  const approach = run(near, steady({ scale: 0.32, y: 0.50 }, 12)).pop();
  check('приближение к камере не читается как присед', near.crouch === false,
    `голоса: ${JSON.stringify(approach.votes)}, защита: ${approach.scaleGuardOk}`);

  // Колени голосуют только когда их видно: молчание не считается за «да».
  const noKnees = pose({ crouch: 0.5 });
  noKnees[25 * 4 + 3] = 0.1;
  noKnees[26 * 4 + 3] = 0.1;
  const g = geometry(noKnees);
  check('невидимые колени не голосуют', g.kneeVis < 0.5);
});

// ───────────────────────── дрейф ─────────────────────────

group('дрейф', () => {
  // Медленный уход по комнате должен впитаться: ребёнок не виноват, что
  // сместился за минуту, и игра не должна считать это вечным наклоном.
  //
  // Обещание конструкции здесь двойное, и проверяются обе половины: во время
  // ухода дорожка не должна сработать, а после остановки смещение должно
  // рассосаться само. Требовать, чтобы u оставалось крошечным прямо во время
  // ухода, нельзя — интегратор по определению отстаёт.
  const slow = makeTracker();
  run(slow, steady({ x: 0.5 }, 40)); // 2 секунды в центре — интегратор включился
  const sliding = [];
  for (let i = 0; i < 200; i++) sliding.push(pose({ x: 0.5 + 0.06 * (i / 200) })); // 10 с
  const during = run(slow, sliding, { t0: 2000 });
  check('во время медленного ухода дорожка не срабатывает',
    during.every((r) => r.lane === 0), 'иначе дрейф читается как намеренный шаг');
  check('дрейф действительно применялся', during.some((r) => r.driftApplied));

  // Ребёнок остановился на новом месте — за десять секунд это становится его
  // новой нейтралью.
  const after = run(slow, steady({ x: 0.56 }, 400), { t0: 12000 }).pop();
  check('после остановки смещение рассасывается', Math.abs(after.u) < S.uDeadband,
    `u = ${after.u.toFixed(3)}`);

  // А резкий шаг — нет.
  const step = makeTracker();
  run(step, steady({ x: 0.5 }, 40));
  const jumped = run(step, steady({ x: 0.5 - 0.16 }, 10)).pop();
  check('резкий шаг не впитан', Math.abs(jumped.u) > S.uEnter * 0.8,
    `u = ${jumped.u.toFixed(3)}`);
});

// ───────────────────── присутствие и пауза ─────────────────────

group('присутствие', () => {
  const why = (opts) => {
    const tr = makeTracker();
    run(tr, steady({}, 5));
    return run(tr, steady(opts, 3)).pop().why;
  };
  check('низкая видимость опознана', why({ vis: 0.2 }) === 'lowvis');
  check('уход к краю кадра опознан', why({ x: 0.03 }) === 'edge');
  check('поворот боком опознан', why({ profile: 0.15 }) === 'profile');
  check('слишком близко к камере опознано', why({ scale: 0.6 }) === 'scale');

  const none = makeTracker();
  run(none, steady({}, 5));
  const lost = none.push({ lm: null, t: 1000 });
  check('отсутствие позы опознано', lost.why === 'none' && lost.ok === false);

  // Граница ухода в паузу: 700 мс. Проверяем обе стороны, потому что ошибка
  // здесь означает либо паузу от каждого моргания распознавания, либо
  // ребёнка, который ушёл, а игра бежит дальше.
  const tr = makeTracker();
  run(tr, steady({}, 5));
  const before = tr.push({ lm: null, t: 1000 });
  const atEdge = tr.push({ lm: null, t: 1000 + S.lostMs - 1 });
  const past = tr.push({ lm: null, t: 1000 + S.lostMs + 1 });
  check('до порога ещё не потерян', atEdge.lostMs < S.lostMs, `${atEdge.lostMs}`);
  check('за порогом потерян', past.lostMs > S.lostMs, `${past.lostMs}`);
  check('отсчёт потери идёт от первого пропавшего кадра', before.lostMs === 0);

  // Подмена субъекта: в кадр вошёл второй ребёнок, и модель перескочила.
  const jump = makeTracker();
  run(jump, steady({ x: 0.5 }, 5));
  const swapped = jump.push({ lm: pose({ x: 0.5 + S.jumpMax + 0.05 }), t: 9999 });
  check('скачок центра опознан как подмена', swapped.why === 'jump');
});

// ───────────────────── предсказание панорамы ─────────────────────

group('панорама', () => {
  /* Эта группа появилась после жалобы ребёнка: при смещении вбок дрожали пол
     и стены, резало глаза, укачивало. Причина была в коде — панорама между
     отсчётами достраивалась экстраполяцией `u + скорость × возраст отсчёта`,
     а приход нового отсчёта сбрасывал возраст в ноль. Вид уезжал вперёд и
     дёргался назад двадцать раз в секунду.

     Поэтому проверяется не «похоже на правду», а само свойство, которого не
     хватало: монотонность. Пока тело едет в одну сторону, взгляд не имеет
     права ни разу повернуть обратно. */
  const follow = makeFollower(VIEW.followMs);
  const dtFrame = 1 / 60;
  const out = [];
  let target = 0;
  for (let frame = 0; frame < 180; frame++) {
    // Отсчёты приходят 20 Гц, кадры рисуются 60 — то есть один новый отсчёт
    // на каждые три кадра. Ровно тот случай, где и ломалось.
    if (frame % 3 === 0) target = frame / 180;
    out.push(follow.step(target, dtFrame));
  }
  let reversals = 0;
  for (let i = 2; i < out.length; i++) {
    if (out[i] - out[i - 1] < -1e-12) reversals++;
  }
  check('взгляд не дёргается назад при движении вперёд', reversals === 0,
    `разворотов: ${reversals} — это и есть та самая тряска`);

  const f2 = makeFollower(VIEW.followMs);
  for (let i = 0; i < 300; i++) f2.step(1, dtFrame);
  check('за несколько периодов догоняет цель', Math.abs(f2.value - 1) < 0.01,
    `дошло до ${f2.value.toFixed(3)}`);

  const f3 = makeFollower(VIEW.followMs);
  f3.step(0, dtFrame);
  const oneFrame = f3.step(1, dtFrame);
  check('за один кадр не прыгает целиком', oneFrame < 0.3,
    `за кадр прошло ${oneFrame.toFixed(3)} — резкий скачок читается как рывок`);

  // Просадка частоты кадров не должна менять ощущение: доля пути считается
  // от настоящего dt.
  const slow = makeFollower(VIEW.followMs);
  slow.step(0, dtFrame);
  const bigStep = slow.step(1, 3 * dtFrame);
  check('при редких кадрах догоняет быстрее за кадр', bigStep > oneFrame);

  /* Та же проверка, но на настоящей цепочке: сценарий «ходьбы» → трекер →
     One-Euro → слежение → поворот взгляда. Браузером это мерить бесполезно —
     граница пола и так ходит на сотни пикселей, и рывок в ней не разглядеть.
     Здесь же видно сам сигнал.

     Тело качается синусоидой 0.3 Гц: за четыре секунды это чуть больше
     одного периода, то есть законных разворотов два-три. Всё сверх этого —
     дрожание. */
  {
    const tr = makeTracker();
    const f = makeFollower(VIEW.followMs);
    const yaws = [];
    let tMs = 0;
    let target = 0;
    for (let frame = 0; frame < 240; frame++) {
      // Позы приходят 20 Гц, кадры рисуются 60.
      if (frame % 3 === 0) {
        const p = SCRIPTS.walk(tMs / 1000);
        const rec = tr.push({ lm: fakeLandmarks({ x: 0.5, ...p }), t: tMs });
        if (rec.ok) target = rec.u;
      }
      // Следим за краем стены в среднем поле: именно он теперь несёт движение.
      yaws.push(project(-VIEW.corridorWidth / 2, 0, 3, camera(f.step(target, 1 / 60), 0)).sx);
      tMs += 1000 / 60;
    }
    let turns = 0;
    let dir = 0;
    for (let i = 1; i < yaws.length; i++) {
      const d = yaws[i] - yaws[i - 1];
      if (Math.abs(d) < 1e-9) continue;
      const s2 = Math.sign(d);
      if (dir && s2 !== dir) turns++;
      dir = s2;
    }
    check('на плавной ходьбе взгляд не дрожит', turns <= 3,
      `разворотов направления: ${turns}; у синусоиды 0.3 Гц за 4 с их должно быть 2–3`);
    check('и при этом действительно двигается',
      Math.max(...yaws) - Math.min(...yaws) > 40,
      'иначе «не дрожит» означало бы просто «не шевелится»');
  }

  // Мёртвая зона: в покое дрожание распознавания не шевелит стены.
  check('дрожание в покое не двигает вид',
    camera(VIEW.viewDeadband * 0.9, 0).x === 0,
    'иначе у неподвижного ребёнка мелко трясутся стены');
  check('а заметное смещение двигает', camera(0.5, 0).x !== 0);
});

// ───────────────────────── геометрия вида ─────────────────────────

group('вид', () => {
  // Эти проверки появились после измерения: сначала панорама двигала картинку
  // на 14 пикселей из 1280 при полном смещении тела — на телевизоре это
  // незаметно, то есть единственной обратной связи в игре не было вовсе.
  const centre = camera(0, 0);
  const left = camera(-1, 0);
  const right = camera(1, 0);

  // Поворота взгляда нет — точка схода стоит на месте. Движение несёт
  // параллакс: стены и пол едут мимо. Мерить его надо там, куда ребёнок
  // смотрит, — в среднем поле, а не у горизонта, где боковой сдвиг камеры по
  // построению почти ничего не меняет. На этом я один раз уже ошибся и сделал
  // неверный вывод, что обратной связи нет.
  const wallAt = (z, cam) => project(-VIEW.corridorWidth / 2, 0, z, cam).sx;

  check('смещение влево двигает стену', wallAt(3, left) !== wallAt(3, centre));
  check('стороны противоположны',
    Math.sign(wallAt(3, left) - wallAt(3, centre)) === -Math.sign(wallAt(3, right) - wallAt(3, centre)));

  const swing = Math.abs(wallAt(3, left) - wallAt(3, right));
  check('движение заметно на телевизоре', swing > VIEW.width * 0.15,
    `${Math.round(swing)} пикселей из ${VIEW.width} на трёх метрах — меньше 15% не читается после сжатия`);

  check('точка схода неподвижна', vanishX(left) === vanishX(right),
    'поворот взгляда убран намеренно: от него укачивает сильнее, чем от поступательного движения');

  // Крена нет по построению: две точки на одной высоте и одной глубине дают
  // одинаковый y при любом состоянии тела. Наклон горизонта — главный
  // источник укачивания, и проверяется он тут, а не на ребёнке.
  for (const cam of [centre, left, right, camera(1, 0.6), camera(-1, 0.3)]) {
    const a = project(-1, 0, 5, cam);
    const b = project(1, 0, 5, cam);
    check('горизонт не наклоняется', Math.abs(a.sy - b.sy) < 1e-9);
  }

  const crouched = camera(0, 0.6);
  check('присед опускает глаза', crouched.y < centre.y);
  check('присед поднимает горизонт в кадре', horizonY(crouched) > horizonY(centre),
    `стоя ${horizonY(centre).toFixed(0)}, присед ${horizonY(crouched).toFixed(0)}`);

  // Сбор звёзд обязан считаться по тому же числу, по которому рисуется кадр.
  check('положение глаз одно на отрисовку и на сбор', cameraX(0.7) === camera(0.7, 0).x);

  // Дальше крайних значений вид не уезжает: иначе на дрожании распознавания
  // картинку швыряло бы за пределы коридора.
  // Зажим: дальше крайнего значения вид не уезжает, иначе дрожание
  // распознавания швыряло бы картинку за пределы коридора. Оба значения
  // заведомо за зажимом — мёртвая зона вычитается до него.
  check('панорама зажата по величине', camera(5, 0).x === camera(3, 0).x);
});

group('звёзды', () => {
  // Вся ценность игры в том, что ребёнок двигается. Если боковую звезду можно
  // собрать стоя столбом, игра превращается в заставку — и именно это и
  // обнаружилось при первом прогоне: допуск был шире, чем ход панорамы.
  const stars = makeStars();
  const side = stars.find((s) => s.x > 0).x;
  const middle = stars.find((s) => s.x === 0).x;

  check('боковую звезду стоя посередине не достать', !canReach(side, 0),
    `звезда на ${side.toFixed(2)} м, взгляд на ${cameraX(0).toFixed(2)} м`);
  check('сместившись — достать', canReach(side, 1),
    `взгляд уходит на ${cameraX(1).toFixed(2)} м`);
  check('в другую сторону — не достать', !canReach(side, -1));

  check('центральную звезду достать стоя посередине', canReach(middle, 0));
  check('а сместившись — уже нет', !canReach(middle, 1),
    'иначе можно висеть в одном положении и собирать всё подряд');
});

// ──────────────────── окошко камеры и поле ────────────────────

group('игровое поле', () => {
  // Полоса показывает ребёнку край пространства, которое видит камера.
  // Зеркалит: камера смотрит спереди, и без зеркала шаг влево уезжал бы на
  // полосе вправо — подсказка, поставленная ради понимания, путала бы.
  const mid = fieldPosition(0.5);
  check('центр кадра — центр полосы', Math.abs(mid.x - 0.5) < 1e-9);
  check('в центре край не грозит', !mid.nearEdge && !mid.outside);

  const childLeft = fieldPosition(0.75);  // ребёнок шагнул влево → в кадре вправо
  check('шаг ребёнка влево двигает отметку влево', childLeft.x < 0.5,
    `отметка на ${childLeft.x.toFixed(2)}`);
  const childRight = fieldPosition(0.25);
  check('шаг вправо — вправо', childRight.x > 0.5);

  const edge = fieldPosition(0.04);
  check('у самого края — «вышел»', edge.outside);
  const near = fieldPosition(0.12);
  check('на подходе к краю — предупреждение', near.nearEdge && !near.outside,
    'предупредить надо до того, как игра встанет на паузу, а не вместе с ней');

  check('без позы поле считает, что ребёнка нет', fieldPosition(null).outside);
});

// ──────────────────── препятствия и телеграф ────────────────────

group('уровень', () => {
  /* Проверяется не «похоже на правду», а инварианты, которые обязаны
     держаться на любом уровне. Непроходимый уровень на глаз не виден — он
     виден ребёнку, который не понимает, почему проиграл. Поэтому тысяча
     разных уровней, а не один. */
  let seed = 12345;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  let minGap = Infinity;
  let sameSideRun = 0;
  let worstSameSide = 0;
  let total = 0;
  let ducks = 0;
  let firstTooEarly = 0;

  for (let i = 0; i < 1000; i++) {
    const level = makeLevel({ durationS: 180, crouch: true, rng });
    if (!level.length) continue;
    if (level[0].at < O.firstAtS) firstTooEarly++;

    let prevSide = 0;
    sameSideRun = 0;
    for (let k = 0; k < level.length; k++) {
      total++;
      if (level[k].kind === 'duck') ducks++;
      if (k > 0) minGap = Math.min(minGap, level[k].at - level[k - 1].at);
      if (level[k].kind === 'side') {
        sameSideRun = level[k].side === prevSide ? sameSideRun + 1 : 0;
        worstSameSide = Math.max(worstSameSide, sameSideRun);
        prevSide = level[k].side;
      }
    }
  }

  check('между препятствиями хватает места на телеграф', minGap >= O.minGapS - 1e-9,
    `самый тесный промежуток ${minGap.toFixed(2)} с при телеграфе ${O.signalS} с`);
  check('времени на решение хватает всегда', minGap >= O.minLeadS,
    'иначе ребёнок физически не успевает — и дело не в ловкости');
  check('разминка не прерывается', firstTooEarly === 0);
  check('подряд в одну сторону не больше двух', worstSameSide <= 2,
    `встретилось ${worstSameSide + 1} подряд; смысл игры в том, что ребёнок двигается`);
  check('приседания встречаются, но не преобладают',
    ducks / total > 0.1 && ducks / total < 0.5,
    `их доля ${(ducks / total * 100).toFixed(0)}%`);

  // Выключенные приседания должны убирать их совсем, а не «пореже».
  const flat = makeLevel({ durationS: 300, crouch: false, rng });
  check('без приседаний верхних препятствий нет', flat.every((o) => o.kind === 'side'),
    'настройка для взрослого обязана работать буквально');
});

group('телеграф', () => {
  // Порядок отметок — это и есть механика. Ошибка в нём не видна на глаз, но
  // ломает игру: ребёнок узнаёт о препятствии позже, чем может среагировать.
  const order = [O.signalS, O.visibleS, O.railS, O.lastCallS];
  check('отметки идут по убыванию', order.every((x, i) => i === 0 || x < order[i - 1]),
    JSON.stringify(order));
  check('сигнал раньше, чем препятствие видно', O.signalS > O.visibleS,
    'звук опережает картинку намеренно: у динамика телефона задержки нет');
  check('времени на решение не меньше заявленного', O.minLeadS <= O.visibleS);

  const far = telegraph(5);
  check('за пять секунд ещё ничего не показано', !far.signal && !far.visible);
  const sig = telegraph(3.5);
  check('за 3.5 с идёт только сигнал', sig.signal && !sig.visible && !sig.rail);
  const vis = telegraph(2.5);
  check('за 2.5 с препятствие видно, рельса ещё нет', vis.visible && !vis.rail);
  const rail = telegraph(1.5);
  check('за 1.5 с идёт рельс', rail.rail && !rail.lastCall);
  const last = telegraph(0.5);
  check('за полсекунды — последний зов', last.lastCall && !last.arrived);
  check('ноль — это приход', telegraph(0).arrived);
});

group('уклонение', () => {
  const edge = obstacleEdge();
  const full = Math.abs(cameraX(1));

  // Уйти должно быть можно. Край препятствия выражен долей хода камеры именно
  // поэтому: развязать эти числа значит получить препятствие, от которого
  // нельзя уклониться в принципе, и заметить это только на ребёнке.
  check('от препятствия можно уйти', edge < full,
    `край на ${edge.toFixed(2)} м при ходе камеры ${full.toFixed(2)} м`);
  check('но уйти надо заметно, а не качнуться', edge > full * 0.2,
    'иначе достаточно стоять и чуть шевелиться');

  const right = { kind: 'side', side: 1 };
  check('закрыта правая — спасает левая', isSafe(right, { camX: -full }));
  check('стоять посередине не спасает', !isSafe(right, { camX: 0 }));
  check('уйти в закрытую сторону не спасает', !isSafe(right, { camX: full }));

  const left = { kind: 'side', side: -1 };
  check('и симметрично', isSafe(left, { camX: full }) && !isSafe(left, { camX: -full }));

  const duck = { kind: 'duck', side: 0 };
  check('верхнее проходится приседом', isSafe(duck, { camX: 0, crouching: true }));
  check('а смещением вбок — нет', !isSafe(duck, { camX: full, crouching: false }),
    'иначе присед можно было бы не делать вовсе');
});

// ───────────────────────── калибровка ─────────────────────────

/* Стадии кончаются по удержанию, а не по абсолютному времени, поэтому
   кормить их фиксированным числом миллисекунд ненадёжно: часть уходит на
   переход. Кормим, пока автомат не сообщит о событии. */
function feedUntilEvent(cal, opts, clock, maxMs = 20000) {
  const stop = clock.t + maxMs;
  while (clock.t < stop) {
    const r = cal.push(pose(opts), clock.t);
    clock.t += 50;
    if (r.done || r.advanced || r.retry || r.gaveUp) return r;
  }
  return { timeout: true };
}

group('калибровка', () => {
  const cal = makeCalibration();
  const clock = { t: 0 };

  check('первая стадия — нейтраль', cal.stage.id === 'neutral');
  feedUntilEvent(cal, { x: 0.5 }, clock);
  check('после нейтрали просит шагнуть влево', cal.stage.id === 'left', `сейчас ${cal.stage?.id}`);

  feedUntilEvent(cal, { x: 0.5 + 0.09 }, clock); // влево у ребёнка = вправо в кадре
  check('после левой стадии просит вправо', cal.stage.id === 'right', `сейчас ${cal.stage?.id}`);

  feedUntilEvent(cal, { x: 0.5 - 0.09 }, clock);
  check('после правой просит присесть', cal.stage.id === 'crouch', `сейчас ${cal.stage?.id}`);

  const done = feedUntilEvent(cal, { crouch: 0.6 }, clock);
  check('калибровка завершилась', done.done === true && !!done.result, JSON.stringify(done));

  const r = done.result;
  check('порог бока в разрешённых границах', r.uEnter >= CLAMP.u[0] && r.uEnter <= CLAMP.u[1],
    `uEnter = ${r?.uEnter}`);
  check('порог приседа в разрешённых границах', r.vEnter >= CLAMP.v[0] && r.vEnter <= CLAMP.v[1],
    `vEnter = ${r?.vEnter}`);
  check('порог выхода ниже порога входа', r.uExit < r.uEnter && r.vExit < r.vEnter);
  check('нейтраль запомнена', r.neutralX > 0 && r.neutralShoulderY > 0 && r.neutralHipY > 0);
  check('длина торса стоя запомнена', r.S0 > 0);

  // Размах вдвое больше обычного не должен сделать жест недостижимым: в азарте
  // ребёнок показывает рекорд, а играть потом будет обычными движениями.
  const wild = makeCalibration();
  const c2 = { t: 0 };
  feedUntilEvent(wild, { x: 0.5 }, c2);
  feedUntilEvent(wild, { x: 0.5 + 0.30 }, c2);
  feedUntilEvent(wild, { x: 0.5 - 0.30 }, c2);
  const wildDone = feedUntilEvent(wild, { crouch: 1.5 }, c2);
  check('огромный размах зажимается сверху',
    wildDone.result && wildDone.result.uEnter <= CLAMP.u[1] && wildDone.result.vEnter <= CLAMP.v[1],
    `uEnter = ${wildDone.result?.uEnter}, vEnter = ${wildDone.result?.vEnter}`);

  // Ребёнок не пошевелился — просим повторить, но не запираем навсегда.
  const lazy = makeCalibration();
  const c3 = { t: 0 };
  feedUntilEvent(lazy, { x: 0.5 }, c3);
  const retry = feedUntilEvent(lazy, { x: 0.5 }, c3);
  check('неподвижность просит повторить', retry.retry === true, JSON.stringify(retry));
  feedUntilEvent(lazy, { x: 0.5 }, c3);
  const gaveUp = feedUntilEvent(lazy, { x: 0.5 }, c3);
  check('после трёх попыток идёт дальше, а не запирает',
    gaveUp.gaveUp === true || lazy.stage?.id !== 'left',
    'застрять на экране, с которого нет выхода, хуже, чем неидеальный порог');
});

group('сдвиг штатива', () => {
  const cal = { neutralX: 0.5, S0: 0.2 };
  check('та же сцена — калибровка годна', !isStale(cal, geometry(pose({ x: 0.5, scale: 0.2 }))));
  check('ребёнок стал заметно крупнее — калибровка устарела',
    isStale(cal, geometry(pose({ x: 0.5, scale: 0.35 }))));
});

// ─────────────────────────── итог ───────────────────────────

if (failed) {
  console.error(`\n${failed} провал(ов) из ${passed + failed} проверок`);
  process.exit(1);
}
console.log(`\nвсё сошлось: ${passed} проверок`);
