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
import { OBSTACLES as O, FINISH } from './js/config.js';
import { describe, motifFor } from './js/audio.js';
import { OPTIONS } from './js/settings.js';
import {
  makeDecor, ringSquash, palmSway, warnBlink, wallNearEdgeX, starAllowed,
  CORRIDOR_HALF, CLIFF_TOP,
} from './js/view.js';
import { players, normalizeName, rankRecords, capRecords, NAME_MAX } from './js/players.js';
import {
  THEME, DECOR, MOTION, GAP_GUARD, DECISION_KEYS, BACKGROUND_KEYS,
  luminance, motionScale,
} from './js/theme.js';


let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ПРОВАЛ  ${name}${detail ? '\n          ' + detail : ''}`);
}
function group(name, fn) { console.log(name); return fn(); }

/* Случайность с посевом. Генераторы уровня, звёзд и декораций принимают rng
   снаружи именно для этого: тест прогоняет тысячу РАЗНЫХ уровней, а не один и
   тот же, и при этом каждый прогон повторяем. */
function seeded(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

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

group('единицы кадра', () => {
  /* Самая дорогая ошибка этапа, найденная на живом ребёнке.

     MediaPipe нормирует x по ширине кадра, а y по высоте. Длина торса
     считается через hypot, то есть смешивает их — и при кадре 16:9
     горизонтальные расстояния выходят вдвое меньше настоящих. Отношение
     ширины плеч к торсу получалось 0.48 при пороге 0.45: ребёнок, стоящий
     строго лицом, висел на волосок от «повернись к телевизору» и однажды там
     застрял насовсем.

     Проверяется физическая величина: у человека лицом к камере плечи
     составляют примерно 0.86 торса, и это не должно зависеть от формы кадра. */
  const реальный = (plechi, torso, w, h) => {
    const aspect = w / h;
    const Hm = 2.0, Wm = Hm * aspect;
    // Точки в нормированных координатах, как их отдаёт MediaPipe.
    const lm = new Float32Array(33 * 4);
    const put = (i, x, y) => { lm[i * 4] = x; lm[i * 4 + 1] = y; lm[i * 4 + 3] = 0.9; };
    put(11, 0.5 - plechi / 2 / Wm, 0.4);
    put(12, 0.5 + plechi / 2 / Wm, 0.4);
    put(23, 0.5 - plechi / 3 / Wm, 0.4 + torso / Hm);
    put(24, 0.5 + plechi / 3 / Wm, 0.4 + torso / Hm);
    return geometry(lm, aspect);
  };

  for (const [w, h, name] of [[640, 360, '16:9'], [640, 480, '4:3'], [360, 640, 'портрет']]) {
    const g = реальный(0.30, 0.35, w, h);
    check(`${name}: плечи к торсу около 0.86`, Math.abs(g.shoulderRatio - 0.30 / 0.35) < 0.02,
      `получилось ${g.shoulderRatio.toFixed(2)}`);
    check(`${name}: стоящий лицом не читается как повёрнутый`, g.shoulderRatio > S.profileRatio,
      `${g.shoulderRatio.toFixed(2)} против порога ${S.profileRatio}`);
  }

  // И смещение в длинах торса тоже не должно зависеть от формы кадра:
  // полшага вбок — это полшага вбок при любой камере.
  const смещение = (w, h) => {
    const aspect = w / h;
    const Hm = 2.0, Wm = Hm * aspect;
    const tr = makeTracker({}, { aspect });
    const кадр = (dx) => {
      const lm = new Float32Array(33 * 4);
      const put = (i, x, y) => { lm[i * 4] = x; lm[i * 4 + 1] = y; lm[i * 4 + 3] = 0.9; };
      const c = 0.5 + dx / Wm;
      put(11, c - 0.15 / Wm, 0.4); put(12, c + 0.15 / Wm, 0.4);
      put(23, c - 0.10 / Wm, 0.4 + 0.35 / Hm); put(24, c + 0.10 / Wm, 0.4 + 0.35 / Hm);
      put(25, c - 0.10 / Wm, 0.4 + 0.6 / Hm); put(26, c + 0.10 / Wm, 0.4 + 0.6 / Hm);
      put(27, c - 0.10 / Wm, 0.4 + 0.9 / Hm); put(28, c + 0.10 / Wm, 0.4 + 0.9 / Hm);
      return lm;
    };
    let t = 0, rec;
    for (let i = 0; i < 5; i++) rec = tr.push({ lm: кадр(0), t: t += 50 });
    for (let i = 0; i < 5; i++) rec = tr.push({ lm: кадр(0.175), t: t += 50 });
    return rec.uRaw;
  };
  const широкий = смещение(640, 360);
  const узкий = смещение(640, 480);
  check('смещение не зависит от формы кадра', Math.abs(широкий - узкий) < 0.05,
    `16:9 дало ${широкий.toFixed(2)}, 4:3 дало ${узкий.toFixed(2)}`);
  check('полторса вбок читается как полторса', Math.abs(Math.abs(широкий) - 0.5) < 0.05,
    `получилось ${Math.abs(широкий).toFixed(2)}`);
});

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
  check('слишком близко к камере опознано', why({ scale: 0.95 }) === 'scale');
  check('слишком далеко опознано', why({ scale: 0.05 }) === 'scale');

  /* А рабочий диапазон отвергаться не должен. Числа из журнала с телефона:
     весь забег длина торса держалась 0.35–0.45, и прежний потолок 0.45
     проходил ровно по нему — игра встала посреди игры с «отойди назад». */
  for (const scale of [0.35, 0.40, 0.45, 0.50, 0.65]) {
    check(`длина торса ${scale} — рабочая, не повод для паузы`, why({ scale }) === null,
      `получилось «${why({ scale })}»`);
  }

  /* Верхняя граница — от своего роста, а не от абсолютной доли кадра.

     Абсолютный потолок 0.80 для взрослого 173 см работает: подошёл к
     телефону, торс дошёл до 1.07, пауза сработала. Для ребёнка 100–130 см
     торс в кадре короче почти вдвое, и 0.80 недостижим вовсе — ребёнок
     упирается в телефон, а игра молчит, потому что формально он в рабочем
     диапазоне. Числа S0 ниже — из журнала и из пересчёта на детский рост. */
  const whyFor = (cal, opts) => {
    const tr = makeTracker(cal);
    run(tr, steady({ scale: cal.S0 }, 5));
    return run(tr, steady(opts, 3)).pop().why;
  };
  check('ребёнок, подошедший к телефону, опознан',
    whyFor({ S0: 0.28 }, { scale: 0.60 }) === 'scale',
    'абсолютный потолок 0.80 этого не поймал бы');
  check('ребёнку его рабочая дистанция паузой не считается',
    whyFor({ S0: 0.28 }, { scale: 0.30 }) === null);
  check('взрослый, подошедший к телефону, опознан',
    whyFor({ S0: 0.53 }, { scale: 1.07 }) === 'scale');
  check('взрослому отход к старту паузой не считается',
    whyFor({ S0: 0.53 }, { scale: 0.40 }) === null,
    'торс на калибровке систематически больше, чем в забеге: 0.53 против 0.40');

  /* А догадка по первому кадру потолок задавать не вправе: на стадии
     установки штатива длина торса была 2.1, и привязка к ней выдала бы либо
     ничего, либо ложную паузу за шаг вперёд. */
  check('без пройденной калибровки потолок остаётся абсолютным',
    why({ scale: 0.65 }) === null && why({ scale: 0.95 }) === 'scale');

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

group('расстановка звёзд', () => {
  /* Проверка появилась после замера на ребёнке: две звезды подряд на разных
     сторонах оказались физически недостижимы — перейти из левого положения в
     правое за отведённое время он не успевал.

     Поэтому проверяется не «похоже на правду», а само физическое условие: на
     смену стороны всегда даётся больше времени, чем на звезду, за которой
     идти никуда не надо. Прогон на тысяче раскладок, а не на одной. */
  const rng = seeded(777);

  let худшийПереход = Infinity;
  let худшийОбычный = Infinity;
  let подрядОдна = 0;
  let всего = 0;

  for (let k = 0; k < 1000; k++) {
    const st = makeStars({ durationS: 120, rng });
    всего += st.length;
    let run = 0;
    for (let i = 1; i < st.length; i++) {
      const dt = st[i].at - st[i - 1].at;
      const переход = st[i].side && st[i - 1].side && st[i].side !== st[i - 1].side;
      if (переход) худшийПереход = Math.min(худшийПереход, dt);
      else худшийОбычный = Math.min(худшийОбычный, dt);
      if (st[i].side && st[i].side === st[i - 1].side) { run++; подрядОдна = Math.max(подрядОдна, run); }
      else run = 0;
    }
  }

  check('на смену стороны даётся не меньше заявленного',
    худшийПереход >= VIEW.starSwitchS - 1e-9,
    `минимум ${худшийПереход.toFixed(2)} с при заявленных ${VIEW.starSwitchS}`);
  check('переход дороже обычного промежутка', VIEW.starSwitchS > VIEW.starGapS,
    'иначе смена стороны ничего не стоит, а она стоит времени');
  check('обычный промежуток не меньше заявленного',
    худшийОбычный >= VIEW.starGapS - 1e-9, `${худшийОбычный.toFixed(2)} с`);
  check('подряд на одной стороне не больше двух', подрядОдна <= 1,
    `встретилось ${подрядОдна + 1} подряд; смысл игры в том, что ребёнок двигается`);
  check('звёзд не слишком густо', всего / 1000 / 120 < 0.55,
    `${(всего / 1000 / 120).toFixed(2)} звезды в секунду`);

  // Время прихода и расстояние обязаны совпадать: звезда на z приезжает к
  // игроку через z/скорость, и расходиться эти две величины не должны.
  const st = makeStars({ durationS: 60, rng });
  check('расстояние соответствует времени',
    st.every((s) => Math.abs(s.z - s.at * VIEW.speed) < 1e-9));
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
  const rng = seeded(12345);

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

  // Окно далёкой метки удлинено до двух секунд (signalS 5.0 против visibleS
  // 3.0) после жалобы «плохо видно предупреждение»: при метке в одну секунду
  // мерцание 1 Гц успевает показать один цикл, то есть не читается вовсе.
  const far = telegraph(6);
  check('за шесть секунд ещё ничего не показано', !far.signal && !far.visible);
  const sig = telegraph(4.5);
  check('за 4.5 с идёт только сигнал', sig.signal && !sig.visible && !sig.rail);
  const sig2 = telegraph(3.5);
  check('за 3.5 с сигнал ещё идёт — окно метки двухсекундное',
    sig2.signal && !sig2.visible, 'иначе медленному мерцанию негде показаться');
  check('метка не накладывается на соседнее препятствие', O.minGapS > O.signalS,
    `minGapS ${O.minGapS} против signalS ${O.signalS}`);
  const vis = telegraph(2.5);
  check('за 2.5 с препятствие видно, рельса ещё нет', vis.visible && !vis.rail);
  const rail = telegraph(1.5);
  check('за 1.5 с идёт рельс', rail.rail && !rail.lastCall);
  const last = telegraph(0.5);
  check('за полсекунды — последний зов', last.lastCall && !last.arrived);
  check('ноль — это приход', telegraph(0).arrived);

  // Пока открыто окно прощения, ребёнок ещё может уйти — и обязан видеть,
  // куда. Поэтому вплотную препятствие перестаёт рисоваться: иначе оно
  // закрывает проём именно в эти миллисекунды.
  const forgiveS = O.lateForgiveMs / 1000;
  check('препятствие исчезает не раньше окна прощения',
    O.drawNearM / VIEW.speed >= forgiveS - 1e-9,
    `исчезает за ${(O.drawNearM / VIEW.speed).toFixed(2)} с, окно ${forgiveS} с`);
  check('и не слишком рано', O.drawNearM / VIEW.speed < 1.0,
    'иначе препятствие пропадает, когда решение ещё не принято');
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

group('звук', () => {
  // Мотивы различаются числом нот, а не только высотой: высоту съедает
  // телефонный динамик и комнатное эхо, а «два» и «три» слышно всегда.
  const m = describe();
  const need = ['left', 'right', 'duck', 'ready', 'warn', 'clear', 'star', 'hit', 'finish'];
  for (const name of need) check(`мотив «${name}» есть`, m[name]?.length > 0);

  check('присед отличается от боковых числом нот',
    m.duck.length !== m.left.length && m.duck.length !== m.right.length,
    `присед ${m.duck.length}, влево ${m.left.length}, вправо ${m.right.length}`);
  check('подтверждение короче предупреждения', m.ready.length < m.warn.length,
    'подтверждение звучит чаще и не должно надоедать');
  check('финиш — самый длинный',
    m.finish.length >= Math.max(...need.map((n) => m[n].length)));

  // Одинаковое число нот у «влево» и «вправо» — так и задумано, их различает
  // направление хода высоты. Но сами мотивы обязаны отличаться.
  check('влево и вправо — разные мотивы',
    JSON.stringify(m.left) !== JSON.stringify(m.right));
  check('влево идёт вниз', m.left[0][0] > m.left[1][0],
    `${m.left[0][0]} → ${m.left[1][0]}`);
  check('вправо идёт вверх', m.right[0][0] < m.right[1][0]);

  // Ноты не должны накладываться сами на себя: следующая начинается не
  // раньше, чем кончилась предыдущая, иначе мотив превращается в аккорд и
  // ритм, которым они и различаются, пропадает.
  for (const [name, notes] of Object.entries(m)) {
    for (let i = 1; i < notes.length; i++) {
      check(`«${name}»: ноты не наезжают`, notes[i][1] >= notes[i - 1][1],
        `нота ${i} начинается в ${notes[i][1]}, предыдущая в ${notes[i - 1][1]}`);
    }
  }

  check('для бокового справа звучит «влево»', motifFor({ kind: 'side', side: 1 }) === 'left',
    'закрыта правая сторона — уходить надо влево, и звук говорит именно это');
  check('для бокового слева звучит «вправо»', motifFor({ kind: 'side', side: -1 }) === 'right');
  check('для верхнего звучит присед', motifFor({ kind: 'duck', side: 0 }) === 'duck');
});

group('финиш', () => {
  // Ворота должны появиться раньше, чем до них можно добежать: иначе они
  // возникают из ниоткуда прямо перед носом.
  check('ворота видно заранее', FINISH.visibleS * VIEW.speed <= VIEW.fogDistance,
    `${(FINISH.visibleS * VIEW.speed).toFixed(0)} м при видимости ${VIEW.fogDistance} м`);
  check('ворота не выше стен', FINISH.gateHeight <= 2.6);
  check('перерыв предлагается не слишком поздно', FINISH.restAfterRuns <= 4,
    'ребёнок сам не остановится, и напоминание нужно взрослому');

  /* Длина забега берётся из родительского меню. Верхняя граница поднята до
     двенадцати минут по просьбе заказчика; нижняя держится, чтобы забег не
     кончался раньше, чем встретится первое препятствие. */
  for (const o of OPTIONS.runLength) {
    check(`длина ${o.label} разумна`, o.value >= 120 && o.value <= 720, `${o.value} с`);
    check(`за ${o.label} успевает встретиться препятствие`, o.value > O.firstAtS + O.minGapS,
      'иначе забег кончится раньше, чем начнётся');
  }
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
  /* Калибровку переигрывать каждый раз незачем — двадцать секунд, а ребёнок
     хочет бежать. Прошлая принимается, если сцена та же. Эта проверка и
     решает, когда «та же». */
  const cal = { neutralX: 0.5, S0: 0.2 };
  check('та же сцена — калибровка годна', !isStale(cal, geometry(pose({ x: 0.5, scale: 0.2 }))));
  check('небольшая разница допустима', !isStale(cal, geometry(pose({ x: 0.52, scale: 0.21 }))),
    'иначе калибровка будет требоваться после каждого шага в сторону');
  check('ребёнок стал заметно крупнее — калибровка устарела',
    isStale(cal, geometry(pose({ x: 0.5, scale: 0.35 }))));
  check('штатив развернули — тоже устарела',
    isStale(cal, geometry(pose({ x: 0.72, scale: 0.2 }))));

  // Без калибровки и без позы решать нечего, и падать тоже не на чем.
  /* Числа из журнала 6 октября: на калибровке торс 0.53, в забеге 0.40.
     Расхождение 25% — ровно по прежнему допуску, и прошлая калибровка не
     переиспользовалась ни разу (`calib.reuse reuse:false had:true
     stale:true`), то есть двадцать секунд калибровки проходились каждый раз.
     Разница систематическая, а не шумовая: игрок возится у телефона, пока
     идёт установка штатива, и отходит только к старту. */
  const реальный = { neutralX: 0.5, S0: 0.53 };
  check('тот же игрок после отхода к старту — калибровка годна',
    !isStale(реальный, geometry(pose({ x: 0.5, scale: 0.40 }))),
    'иначе двадцать секунд калибровки будут проходиться перед каждым забегом');
  check('а развёрнутый штатив по-прежнему роняет калибровку',
    isStale(реальный, geometry(pose({ x: 0.78, scale: 0.53 }))),
    'допуск по нейтрали ослаблять нельзя — ради него проверка и существует');

  check('нет калибровки — не устарела', !isStale(null, geometry(pose({}))));
  check('нет позы — не устарела', !isStale(cal, null));
});

group('тема', () => {
  /* Эта группа существует из-за одного риска. Тема «зелёные холмы» делает мир
     светлым и зелёным, а до неё коридор был тёмно-синим, и контраст «плита /
     проём» получался сам. Теперь он сам не получается, а именно он сообщает
     ребёнку, куда уходить. Проверять его глазами нельзя: после Miracast кадр
     выглядит иначе, чем на машине разработки.

     Поэтому правило выражено числом: ФОРМА СООБЩАЕТ ТЕМУ, СВЕТЛОТА СООБЩАЕТ
     РЕШЕНИЕ. */
  const t = THEME.greenHill;
  const L = luminance;

  // Порог взят замером прежней палитры, а не выдуман: столько контраста уже
  // было, и терять его при покраске нельзя ни в каком случае.
  const baseline = L('#4fd6a0') - L('#c2415a');
  check('контраст «плита / проём» не ниже прежнего',
    L(t.gap) - L(t.block) >= baseline,
    `было ${baseline.toFixed(3)}, стало ${(L(t.gap) - L(t.block)).toFixed(3)}`);

  check('проём светлее всего фона',
    BACKGROUND_KEYS.every((k) => L(t[k]) < L(t.gap)),
    'иначе «куда идти» перестанет быть самым заметным местом кадра');

  for (const k of BACKGROUND_KEYS) {
    check(`фон «${k}» не лезет в канал решения`,
      Math.abs(L(t[k]) - L(t.gap)) >= GAP_GUARD,
      `${t[k]}: разница ${Math.abs(L(t[k]) - L(t.gap)).toFixed(3)} при пороге ${GAP_GUARD}`);
  }

  /* Цвет, не отнесённый ни к решению, ни к фону, не проверяется ничем — и
     именно так в палитру и попадёт однажды белая декорация. Единственное
     исключение названо в theme.js: глаз бадника в несколько пикселей. */
  const classified = new Set([...DECISION_KEYS, ...BACKGROUND_KEYS, 'badnikEye', 'id', 'name']);
  check('каждый цвет палитры отнесён к роли',
    Object.keys(t).every((k) => classified.has(k)),
    `без роли: ${Object.keys(t).filter((k) => !classified.has(k)).join(', ')}`);

  check('левый и правый обрыв различаются по светлоте',
    Math.abs(L(t.earthL) - L(t.earthR)) > 0.02,
    'разница светлоты подсказывает, в какую сторону уехал взгляд');

  check('шахматка пола различима',
    Math.abs(L(t.floorA) - L(t.floorB)) > 0.1,
    'без этого пол сливается и скорость перестаёт читаться');
});

group('декорации', () => {
  const decor = makeDecor({ durationS: 60, rng: seeded(1) });

  check('декорации расставлены', decor.length > 10);

  /* Главное свойство: декорация не участвует в игре. Проверяется не доверием
     к отрисовке, а положением — всё стоит строго за пределами коридора. */
  check('ни одна декорация не стоит в игровой полосе',
    decor.every((d) => Math.abs(d.x) > CORRIDOR_HALF),
    'иначе пальма закроет проём, и ребёнок проиграет из-за украшения');

  check('все декорации выше кромки обрыва',
    decor.every((d) => d.y >= CLIFF_TOP),
    'стены рисуются сплошными до тумана и всё за собой закрывают');

  check('порядок по глубине не нарушен',
    decor.every((d, i) => i === 0 || d.z >= decor[i - 1].z),
    'по возрастанию глубины отбираются ближние — на них бюджет кадра, — '
    + 'а рисуются они потом в обратную сторону, от дальних к ближним');

  check('расставлены по обе стороны',
    decor.some((d) => d.x < 0) && decor.some((d) => d.x > 0));

  const kinds = new Set(decor.map((d) => d.kind));
  check('виды не выродились в один', kinds.size >= 3, [...kinds].join(', '));
  check('виды только из таблицы',
    decor.every((d) => DECOR.kinds.some((k) => k.kind === d.kind)));

  /* Детерминированность. Иначе в истории правок не видно, что изменилось: при
     каждом прогоне уровень выглядит иначе, и сравнить два снимка нельзя. */
  const again = makeDecor({ durationS: 60, rng: seeded(1) });
  check('один и тот же посев даёт тот же уровень',
    JSON.stringify(decor) === JSON.stringify(again));
  const other = makeDecor({ durationS: 60, rng: seeded(2) });
  check('другой посев даёт другой уровень',
    JSON.stringify(decor) !== JSON.stringify(other));

  // Плотность задана временем, а не метрами: при смене скорости бега уровень
  // должен выглядеть так же густо.
  const expected = 60 / DECOR.gapS;
  check('плотность примерно та, что заказана',
    Math.abs(decor.length - expected) < expected * 0.5,
    `${decor.length} против ожидаемых ~${expected.toFixed(0)}`);

  check('длинный забег не выродился', makeDecor({ durationS: 300, rng: seeded(3) }).length > 100);
  check('нулевая длительность не ломает', makeDecor({ durationS: 0, rng: seeded(4) }).length === 0);
});

group('анимации', () => {
  /* Все анимации — функции времени. Это проверяемо в node ровно потому, что
     ни одна не копит состояние: при 20 Гц источника поз и просадках кадра
     накопительная анимация расходится с картинкой, а функция — нет. */
  check('кольцо: один и тот же момент даёт один и тот же вид',
    ringSquash(3.25, 0.4) === ringSquash(3.25, 0.4));

  const squashes = [];
  for (let travel = 0; travel < 4; travel += 0.05) squashes.push(ringSquash(travel, 0));
  check('кольцо не выворачивается наизнанку', squashes.every((s) => s > 0 && s <= 1),
    'отрицательная ширина нарисует кольцо зеркально');
  check('кольцо действительно крутится', Math.max(...squashes) - Math.min(...squashes) > 0.5);
  check('кольцо не исчезает совсем', Math.min(...squashes) > 0.05,
    'в профиль кольцо должно оставаться видимым: это цель, а не украшение');

  check('пальма качается вокруг своего места',
    Math.abs(palmSway(0, 0) + palmSway(2 / MOTION.palmSwayHz / 2, 0)) < 1e-9,
    'иначе крона уедет от ствола');
  const sway = [];
  for (let travel = 0; travel < 8; travel += 0.1) sway.push(palmSway(travel, 0.3));
  check('качание в заданных пределах',
    sway.every((s) => Math.abs(s) <= MOTION.palmSwayM + 1e-9));

  /* «Меньше движения» сжимает амплитуду, а не выключает код: нулевой путь,
     который никто не видит, отдельно гниёт. Ребёнок на укачивание уже
     жаловался — из-за этого в игре нет поворота взгляда. */
  check('обычный режим — полная амплитуда', motionScale(false) === 1);
  check('«меньше движения» сжимает, но не до нуля',
    motionScale(true) > 0 && motionScale(true) < 0.2);
  check('сжатие действует на качание',
    Math.abs(palmSway(1.7, 0, motionScale(true))) < Math.abs(palmSway(1.7, 0, 1)));
  check('сжатие действует на кольцо',
    1 - ringSquash(1.7, 0, motionScale(true)) < 1 - ringSquash(1.7, 0, 1));

  /* Мерцание далёкого предупреждения. Устроено наоборот остальных: сжатие
     амплитуды прижимает его к ЕДИНИЦЕ, то есть метка остаётся ровно яркой.
     Это сообщение о решении, и системная настройка не имеет права его
     погасить — не по аккуратности, а по построению. */
  check('мерцание: один и тот же момент даёт один и тот же вид',
    warnBlink(2.75, 0.4) === warnBlink(2.75, 0.4));
  const blink = [];
  for (let t = 0; t < 4; t += 0.02) blink.push(warnBlink(t, 0));
  check('мерцание в пределах 0..1', blink.every((b) => b >= -1e-9 && b <= 1 + 1e-9));
  check('метка действительно мерцает', Math.max(...blink) - Math.min(...blink) > 0.9);
  check('за две секунды окна успевают два цикла', MOTION.warnBlinkHz * 2 >= 2,
    `при ${MOTION.warnBlinkHz} Гц мерцание не прочитается как мерцание`);
  const quiet = [];
  for (let t = 0; t < 4; t += 0.02) quiet.push(warnBlink(t, 0, motionScale(true)));
  check('«меньше движения» оставляет метку яркой', Math.min(...quiet) > 0.5,
    `минимум ${Math.min(...quiet).toFixed(2)} — ниже половины метка гаснет`);
});

// ──────────────────────── стены до края кадра ────────────────────────

group('стены', () => {
  /* Щель, которую видно только на телевизоре и только в крайнем положении.

     Обрыв и пол — плоскости при постоянном x, а точка схода стоит на месте
     (yawPx = 0): панорама их не растягивает, а двигает. Поэтому ближний угол
     правого обрыва при полном смещении вправо уезжал ВНУТРЬ кадра, и справа
     от него оставалась полоса 68 px сплошного неба — буфер залит им перед
     всем остальным. Выглядело дыркой в мире; пожаловался заказчик.

     Числом это ловится сразу, глазами — почти никогда: нужно одновременно
     уйти в самый край и посмотреть не туда, куда смотрит игра. */
  for (const u of [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]) {
    const left = wallNearEdgeX(u, -1);
    const right = wallNearEdgeX(u, 1);
    check(`при u=${u} левый обрыв доходит до края кадра`, left <= 0,
      `ближний угол на ${left.toFixed(0)} px — слева видно небо`);
    check(`при u=${u} правый обрыв доходит до края кадра`, right >= VIEW.width,
      `ближний угол на ${right.toFixed(0)} px при ширине ${VIEW.width} — справа видно небо`);
  }
});

// ─────────────────── звёзды и препятствия вместе ───────────────────

group('звёзды и препятствия', () => {
  /* Расписания колец и препятствий строились независимо, и это давало
     кольца, которые нельзя собрать, не ударившись. По журналу первого полного
     забега: одиннадцать колец ближе 0.35 с к препятствию, пять — ближе 0.1 с.
     Худший случай — кольцо на u = −0.89 в 0.07 с от приседа: присед и боковой
     наклон одновременно физически невозможны. */

  check('сдвиг кольца всегда сходится за один шаг', O.minGapS > 2 * VIEW.starGuardS,
    `minGapS ${O.minGapS} против удвоенного окна ${2 * VIEW.starGuardS}: `
    + 'при меньшем кольцо вытолкнется в следующее окно и ряд выродится');

  for (const crouch of [true, false]) {
    let bad = 0;
    let total = 0;
    let worst = null;
    for (let seed = 1; seed <= 100; seed++) {
      /* Разные сиды у препятствий и колец — не придирка. С одним сидом обе
         раскладки берут одну и ту же последовательность чисел, стороны колец
         оказываются связаны с видами препятствий, и перебор на сотне уровней
         обходит заметно меньше случаев, чем кажется. Дефект размещения,
         который виден только когда две случайности расходятся, такой перебор
         пропустил бы. */
      const obstacles = makeLevel({ durationS: 300, crouch, rng: seeded(seed * 7919) });
      const stars = makeStars({ durationS: 300, obstacles, rng: seeded(seed * 104729) });
      total += stars.length;
      for (const s of stars) {
        if (starAllowed(s.at, s.side, obstacles)) continue;
        bad++;
        worst ??= `сид ${seed}: кольцо на ${s.at.toFixed(2)} с, сторона ${s.side}`;
      }
    }
    check(`${crouch ? 'с приседами' : 'без приседов'}: ни одно кольцо не спорит с препятствием`,
      bad === 0, `${bad} нарушений, первое — ${worst}`);
    const free = makeStars({ durationS: 300, obstacles: [], rng: seeded(1) }).length;
    check(`${crouch ? 'с приседами' : 'без приседов'}: ряд колец не выродился`,
      total / 100 > free * 0.7,
      `осталось ${(total / 100).toFixed(1)} из ${free} — развязка не должна стоить треть колец`);
  }

  // Само правило, поштучно: оно важнее числа прогонов.
  const duck = [{ at: 20, kind: 'duck', side: 0 }];
  check('под приседом не висит ничего', !starAllowed(20, 0, duck)
    && !starAllowed(20, 1, duck) && !starAllowed(19.5, -1, duck),
    'присед не совмещается ни с наклоном, ни с возвратом в центр');
  check('за окном приседа кольцо снова можно',
    starAllowed(20 + VIEW.starGuardS + 0.01, 1, duck));

  const right = [{ at: 30, kind: 'side', side: 1 }];
  check('у бокового препятствия кольцо есть только на открытой стороне',
    starAllowed(30, -1, right) && !starAllowed(30, 1, right) && !starAllowed(30, 0, right),
    'isSafe: side > 0 закрывает +x, значит открыта −1');

  /* Дотягивание. Четыре неравенства, и важны они все четыре сразу: смысл игры
     в том, что ребёнок двигается. Числа пересчитаны по журналу — прежние
     требовали u ≥ 0.643 при центре кольца на u = 1.58, то есть за пределами
     полного размаха, и взрослый добирал боковые кольца, вываливаясь из кадра
     (три паузы «ты у самого края»). */
  const starX = VIEW.starX * CORRIDOR_HALF;
  check('боковое кольцо стоя не собрать', !canReach(starX, 0),
    `кольцо на ${starX.toFixed(3)} м при допуске ${VIEW.starReach}`);
  check('центральное кольцо в наклоне не собрать', !canReach(0, 1),
    `ход камеры ${cameraX(1).toFixed(3)} м`);
  check('боковое кольцо в наклоне собирается', canReach(starX, 0.85));

  let minU = null;
  let centre = 0;
  let best = Infinity;
  for (let u = 0; u <= 2.0001; u += 0.001) {
    if (canReach(starX, u) && minU === null) minU = u;
    const d = Math.abs(starX - cameraX(u));
    if (d < best) { best = d; centre = u; }
  }
  check('дотянуться хватает трети размаха', minU > 0.25 && minU < 0.45,
    `требуется u ≥ ${minU?.toFixed(3)}`);
  check('за край кадра тянуться не надо', centre < 1,
    `центр кольца приходится на u = ${centre.toFixed(3)}, а у кадра край около 1.41`);
});

// ──────────────────────── игроки и рекорды ────────────────────────

group('игроки', () => {
  /* Калибровка и рекорды принадлежат игроку, а не телефону: взрослый 173 см и
     ребёнок 100–130 см затирали её друг другу, и второй проходил двадцать
     секунд калибровки заново при каждом забеге. */

  check('имя сжимает пробелы', normalizeName('  Богдан   И. ') === 'Богдан И.');
  check('имя обрезается по потолку', normalizeName('а'.repeat(40)).length === NAME_MAX);
  check('обрезка не оставляет пробел на конце',
    normalizeName('Богдан Иван Петров') === 'Богдан Иван',
    `получилось «${normalizeName('Богдан Иван Петров')}»`);
  check('пустое имя не имя', normalizeName('   ') === '');
  check('имя из пробелов не создаёт игрока', players.add('   ') === null);

  const a = players.add('Богдан');
  check('новый игрок создан', a?.created === true && a.name === 'Богдан');
  const again = players.add('богдан');
  check('то же имя в другом регистре — тот же игрок', again?.created === false && again.id === a.id,
    'иначе «Богдан» и «богдан» разойдутся двумя таблицами и двумя калибровками');

  const b = players.add('Рома');
  check('второй игрок создан и выбран', players.current()?.id === b.id);

  /* Подпись под результатом — не смена игрока. Экран на финише спрашивает
     «чей это результат», и если он заодно переключит игрока, то у ребёнка
     следующий забег начнётся с двадцати секунд калибровки по пустому профилю
     гостя — ровно то, ради устранения чего профили и заводились. */
  const гость = players.add('Гость', { select: false });
  check('подпись не переключает игрока', players.current()?.id === b.id,
    `играет ${players.name()}, а должен Рома`);
  check('подписанный игрок всё равно создан', !!гость && гость.created === true);
  players.addRecord({ playerId: гость.id, durationS: 60, stars: 7, starsTotal: 9, hits: 1 });
  check('запись ушла подписанному, а не текущему',
    players.records(60)[0]?.name === 'Гость');

  /* Калибровка не должна течь между игроками — это и есть причина, по которой
     профили появились. */
  players.saveCalibration({ neutralX: 0.5, S0: 0.28 });
  players.select(a.id);
  check('калибровка одного игрока не видна другому', players.loadCalibration() === null);
  players.select(b.id);
  check('своя калибровка на месте', players.loadCalibration()?.S0 === 0.28);

  check('последнего игрока удалить нельзя', (() => {
    const ids = players.all().map((p) => p.id);
    for (const id of ids) players.remove(id);
    return players.all().length === 1;
  })(), 'пустой список заставил бы перенос создать «Игрок 1» с чужой калибровкой');

  // ── порядок в таблице ──
  const rows = [
    { at: 10, stars: 5, hits: 1 },
    { at: 20, stars: 5, hits: 0 },
    { at: 30, stars: 9, hits: 3 },
    { at: 40, stars: 5, hits: 0 },
  ];
  const ranked = rankRecords(rows);
  check('больше колец — выше', ranked[0].stars === 9);
  check('при равных кольцах выше меньше задетых', ranked[1].hits === 0);
  check('при полном равенстве свежее выше', ranked[1].at === 40);
  check('сортировка не портит исходный массив', rows[0].at === 10);

  /* Вытесняется ХУДШАЯ запись, а не самая старая: иначе десяток рутинных
     забегов вынес бы собственно рекорд, ради которого таблица и существует. */
  const many = Array.from({ length: 60 }, (_, i) => ({ at: i, stars: i, hits: 0, durationS: 300 }));
  const capped = capRecords(many, 10);
  check('потолок соблюдён', capped.length === 10);
  check('рекорд выживает при переполнении', rankRecords(capped)[0].stars === 59);
  check('вытесняется худшее, а не старейшее', capped.every((r) => r.stars >= 50),
    `в обрезке осталось ${capped.map((r) => r.stars).join(',')}`);

  /* И потолок действует ВНУТРИ длины, а не поперёк. Иначе пятьдесят
     пятиминутных забегов по сотне колец вытеснили бы первый же трёхминутный с
     шестьюдесятью — молча, в момент записи, и таблица трёх минут осталась бы
     пустой навсегда. Это та же ошибка, от которой уберегает rankRecords. */
  const смешанные = capRecords(
    [...many, { at: 99, stars: 60, hits: 0, durationS: 180 }], 10,
  );
  check('короткий забег не вытесняется длинными',
    смешанные.some((r) => r.durationS === 180),
    'потолок применён поперёк длин — запись пропала в момент записи');
  check('потолок считается по каждой длине отдельно',
    смешанные.filter((r) => r.durationS === 300).length === 10);

  // ── таблицы на длину забега ──
  const me = players.current().id;
  players.addRecord({ durationS: 300, stars: 102, starsTotal: 130, hits: 2 });
  players.addRecord({ durationS: 180, stars: 70, starsTotal: 80, hits: 0 });
  const five = players.records(300);
  check('в таблице только своя длина', five.length === 1 && five[0].stars === 102,
    'сырые кольца за пять минут и за три несравнимы');
  check('имя приклеивается при чтении, а не хранится в записи',
    five[0].name === players.name() && five[0].playerId === me,
    'иначе переименование игрока не переименует его прошлые рекорды');
  const длины = players.lengths();
  check('длины перечислены и упорядочены',
    длины.includes(180) && длины.includes(300)
    && длины.every((v, i) => i === 0 || длины[i - 1] < v),
    'получилось ' + длины.join(','));
  check('без колец запись не создаётся', players.addRecord({ durationS: 300 }) === null);
});

// ─────────────────────────── итог ───────────────────────────

if (failed) {
  console.error(`\n${failed} провал(ов) из ${passed + failed} проверок`);
  process.exit(1);
}
console.log(`\nвсё сошлось: ${passed} проверок`);
