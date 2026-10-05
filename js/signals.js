// Превращение 33 точек скелета в три жеста.
//
// Здесь нет ни DOM, ни воркеров, ни хранилища — только математика над
// числами. Это сделано нарочно: ровно поэтому всё, что ниже, проверяется
// обычным скриптом node, без браузера, камеры и ребёнка. Воркер не считает
// ничего и отдаёт сырые 132 числа именно ради этой границы.
//
// Главная мысль всего файла: ребёнок не стоит на месте. Он дрейфует по
// комнате, поворачивается, машет руками. Поэтому ни одна абсолютная
// координата не годится — всё меряется относительно его собственного тела, в
// долях длины торса.

import { SIGNALS as S, VIEW } from './config.js';
import { clamp } from './util.js';

const { LM } = S;

// ─────────────────────────── One-Euro ───────────────────────────

/* Фильтр с адаптивной частотой среза: сильно сглаживает в покое и почти не
   задерживает на быстром движении. Применяется к двум производным величинам,
   а не к 33 точкам — так дешевле и уместнее.

   Шагать его надо настоящим, нерегулярным dt. Если подставлять ожидаемые
   50 мс, адаптация врёт ровно в тот момент, когда конвейер запнулся, — то
   есть когда фильтр и должен был помочь. */
export function makeOneEuro({ minCutoff, beta, dCutoff }) {
  let xPrev = null;
  let dxPrev = 0;
  const alpha = (cutoff, dt) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return {
    reset() { xPrev = null; dxPrev = 0; },
    get velocity() { return dxPrev; },
    push(x, dt) {
      if (!(dt > 0)) dt = 1 / 60;
      if (xPrev === null) { xPrev = x; return x; }
      const dx = (x - xPrev) / dt;
      dxPrev += alpha(dCutoff, dt) * (dx - dxPrev);
      const cutoff = minCutoff + beta * Math.abs(dxPrev);
      xPrev += alpha(cutoff, dt) * (x - xPrev);
      return xPrev;
    },
  };
}

// ─────────────────────── выжимка из скелета ───────────────────────

const px = (lm, i) => lm[i * 4];
const py = (lm, i) => lm[i * 4 + 1];
const pv = (lm, i) => lm[i * 4 + 3];

/** Угол в точке b между отрезками b→a и b→c, в градусах. */
function angleAt(lm, a, b, c) {
  const abx = px(lm, a) - px(lm, b);
  const aby = py(lm, a) - py(lm, b);
  const cbx = px(lm, c) - px(lm, b);
  const cby = py(lm, c) - py(lm, b);
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!mag) return 180;
  return Math.acos(clamp(dot / mag, -1, 1)) * 180 / Math.PI;
}

/**
 * Геометрия тела из сырых точек. Всё, что дальше, считается отсюда.
 *
 * Длина торса `S` — единица измерения всего файла. Она уменьшается с
 * расстоянием так же, как любое другое измерение в кадре, поэтому деление на
 * неё даёт независимость от того, в двух метрах ребёнок или в трёх. И на неё
 * не влияют ни взмахи руками, ни поворот головы.
 *
 * Ширина плеч для масштаба не годится — она схлопывается, когда ребёнок
 * поворачивается боком. Зато именно поэтому она хороший детектор поворота.
 */
export function geometry(lm) {
  const shoulderX = (px(lm, LM.lShoulder) + px(lm, LM.rShoulder)) / 2;
  const shoulderY = (py(lm, LM.lShoulder) + py(lm, LM.rShoulder)) / 2;
  const hipX = (px(lm, LM.lHip) + px(lm, LM.rHip)) / 2;
  const hipY = (py(lm, LM.lHip) + py(lm, LM.rHip)) / 2;

  const torso = Math.hypot(shoulderX - hipX, shoulderY - hipY);
  const shoulderWidth = Math.abs(px(lm, LM.lShoulder) - px(lm, LM.rShoulder));

  // Центр тела — по четырём точкам, а не по всему скелету: машущие руки не
  // должны сдвигать показание.
  const cx = (px(lm, LM.lShoulder) + px(lm, LM.rShoulder) + px(lm, LM.lHip) + px(lm, LM.rHip)) / 4;

  const vis = (pv(lm, LM.lShoulder) + pv(lm, LM.rShoulder) + pv(lm, LM.lHip) + pv(lm, LM.rHip)) / 4;

  const kneeL = angleAt(lm, LM.lHip, LM.lKnee, LM.lAnkle);
  const kneeR = angleAt(lm, LM.rHip, LM.rKnee, LM.rAnkle);
  const kneeVis = Math.min(pv(lm, LM.lKnee), pv(lm, LM.rKnee));

  return {
    S: torso, cx, shoulderY, hipY, shoulderWidth, vis,
    knee: Math.min(kneeL, kneeR), kneeVis,
    shoulderRatio: torso > 0 ? shoulderWidth / torso : 0,
  };
}

// ───────────────────────────── трекер ─────────────────────────────

const DEFAULT_CALIBRATION = {
  neutralX: null,         // центр тела по X в нейтральной позе
  neutralShoulderY: null, // высота плеч стоя
  neutralHipY: null,      // и бёдер — нужна отдельным голосом за присед
  S0: null,               // длина торса стоя: по ней ловим приближение к камере
  uEnter: S.uEnter, uExit: S.uExit, vEnter: S.vEnter, vExit: S.vExit,
};

/**
 * Состояние поверх потока поз.
 *
 * Отдаёт одну запись, в которой разделение на двух потребителей выражено
 * именами полей, а не двумя разными API:
 *
 *   u, v           — только One-Euro            → панорама (мгновенно)
 *   uLogic, lane   — плюс гистерезис и дедзона  → логика (устойчиво)
 *
 * Перепутать нельзя: чтобы скормить панораме сглаженное значение, пришлось бы
 * специально потянуться к полю с именем uLogic.
 */
export function makeTracker(calibration = {}) {
  const cal = { ...DEFAULT_CALIBRATION, ...calibration };

  const fu = makeOneEuro(S.oneEuro);
  const fv = makeOneEuro(S.oneEuro);

  let tPrev = null;
  let lane = 0;
  let laneSince = 0;
  let lastLaneChange = -1e9;
  let onsetAt = null;
  let onsetDir = 0;
  let crouch = false;
  let crouchSince = 0;
  let lostSince = null;
  let okSince = null;
  let prevCx = null;
  let centeredSince = null;
  const ring = [];

  function presence(g, t) {
    if (g.vis < S.visMin) return 'lowvis';
    if (!(g.S > S.scaleMin && g.S < S.scaleMax)) return 'scale';
    if (g.cx < S.edgeMargin || g.cx > 1 - S.edgeMargin) return 'edge';
    if (g.shoulderRatio < S.profileRatio) return 'profile';
    // Скачок центра больше четверти кадра за такт физически невозможен:
    // значит в кадр вошёл кто-то второй и модель переключилась на него.
    if (prevCx !== null && Math.abs(g.cx - prevCx) > S.jumpMax) return 'jump';
    return null;
  }

  return {
    get lane() { return lane; },
    get crouch() { return crouch; },
    /** Последние отсчёты — уходят в журнал одним событием вокруг происшествия. */
    burst(ms = 2000, now = tPrev) {
      return ring.filter((r) => now - r.t <= ms);
    },

    push({ lm, t, calibration: live }) {
      if (live) Object.assign(cal, live);
      const dt = tPrev === null ? 1 / 60 : Math.max(1e-3, (t - tPrev) / 1000);
      tPrev = t;

      if (!lm) {
        if (lostSince === null) lostSince = t;
        okSince = null;
        return { t, ok: false, why: 'none', lostMs: t - lostSince, lane, crouch };
      }

      const g = geometry(lm);
      const why = presence(g, t);
      prevCx = g.cx;

      if (why) {
        if (lostSince === null) lostSince = t;
        okSince = null;
        return { t, ok: false, why, lostMs: t - lostSince, ...g, lane, crouch };
      }
      lostSince = null;
      if (okSince === null) okSince = t;

      // Первая достоверная поза задаёт нейтраль, если калибровки ещё нет.
      if (cal.neutralX === null) {
        cal.neutralX = g.cx;
        cal.neutralShoulderY = g.shoulderY;
        cal.neutralHipY = g.hipY;
        cal.S0 = g.S;
      }

      // Знак инвертируется: задняя камера смотрит на ребёнка, повёрнутого к
      // ней лицом, и «влево» в кадре противоположно «влево» у ребёнка. Это та
      // ошибка, которая делает игру неиграбельной.
      const uRaw = S.mirrorX * (g.cx - cal.neutralX) / g.S;
      const vRaw = (g.shoulderY - cal.neutralShoulderY) / g.S;
      const vHip = (g.hipY - cal.neutralHipY) / g.S;

      const u = fu.push(uRaw, dt);
      const v = fv.push(vRaw, dt);

      const speed = fu.velocity;

      // ── дрейф ──
      // Нейтраль подтягивается медленно, пока ребёнок не делает ничего
      // осознанного: дорожка свободна, движение небыстрое, порог не взят.
      // Ворота по величине смещения тут не годятся — интегратор отстаёт от
      // медленного ухода больше, чем любая разумная мёртвая зона, и такие
      // ворота захлопнулись бы ровно там, где впитывать и надо.
      let driftApplied = false;
      if (lane === 0 && Math.abs(speed) < S.driftSpeedMax && Math.abs(u) < cal.uEnter) {
        if (centeredSince === null) centeredSince = t;
        if (t - centeredSince > S.driftRequiresCenteredMs) {
          const k = 1 - Math.exp(-(dt * 1000) / S.driftTauMs);
          cal.neutralX += k * (g.cx - cal.neutralX);
          cal.neutralShoulderY += k * (g.shoulderY - cal.neutralShoulderY);
          cal.neutralHipY += k * (g.hipY - cal.neutralHipY);
          driftApplied = true;
        }
      } else {
        centeredSince = null;
      }

      // ── дорожка: гистерезис плюс срабатывание по началу движения ──
      const canChange = t - lastLaneChange > S.laneDebounceMs;
      let laneNext = lane;

      if (lane === 0) {
        const dir = Math.sign(u);
        if (Math.abs(u) > cal.uEnter) {
          laneNext = dir;
        } else if (canChange && Math.abs(u) > S.onsetU && Math.sign(speed) === dir
                   && Math.abs(speed) > S.onsetSpeed) {
          // Начало движения: срабатываем до того, как ребёнок закончил шаг.
          // Это бесплатно возвращает 150–300 мс тракту, который и так тратит
          // около 430 мс.
          laneNext = dir;
          onsetAt = t;
          onsetDir = dir;
        }
      } else if (Math.abs(u) < cal.uExit || Math.sign(u) !== lane) {
        laneNext = 0;
      }

      // Сработали по началу, а движение не состоялось — мягко вернулись.
      // Это единственная отмена, которая разрешена: во всех прочих случаях
      // решение не отыгрывается назад, иначе это читается как баг.
      if (onsetAt !== null && lane !== 0) {
        if (Math.abs(u) > cal.uEnter) onsetAt = null;
        else if (t - onsetAt > S.onsetGiveUpMs && Math.sign(u) === onsetDir) { laneNext = 0; onsetAt = null; }
      }

      let laneChanged = false;
      if (laneNext !== lane && canChange) {
        lane = laneNext;
        laneSince = t;
        lastLaneChange = t;
        laneChanged = true;
      }

      // ── присед ──
      // Длина торса в приседе не меняется вовсе, а «высота плеч над пятками»
      // ломается, когда ступни уходят из кадра. Поэтому голоса.
      // Три независимых признака: опустились плечи, опустились бёдра, согнуты
      // колени. Колени голосуют только когда их видно — у стоящего боком или
      // прикрытого мебелью ребёнка их нет, и молчание не должно считаться «за».
      const votes = {
        sh: v > cal.vEnter,
        hip: vHip > cal.vEnter,
        knee: g.kneeVis > 0.5 && g.knee < S.kneeAngleMax,
      };
      const yes = (votes.sh ? 1 : 0) + (votes.hip ? 1 : 0) + (votes.knee ? 1 : 0);

      // Ребёнок, подошедший к камере, тоже опускает плечи в кадре. Настоящий
      // присед обязан уменьшить рост, не увеличив длину торса.
      const scaleGuardOk = cal.S0 ? (g.S - cal.S0) / cal.S0 < S.scaleGuard : true;

      let crouchChanged = false;
      if (!crouch) {
        if (yes >= S.votesNeeded && scaleGuardOk) { crouch = true; crouchSince = t; crouchChanged = true; }
      } else if (t - crouchSince > S.crouchMinHoldMs && v < cal.vExit) {
        crouch = false;
        crouchChanged = true;
      }

      const rec = {
        t, ok: true, why: null,
        ...g,
        uRaw, vRaw, u, v, speed,
        lane, laneAge: t - laneSince, laneChanged,
        crouch, crouchChanged, votes, scaleGuardOk,
        driftApplied,
        neutral: { x: cal.neutralX, y: cal.neutralY },
        okMs: t - okSince,
      };

      ring.push({ t, u, v, S: g.S, vis: g.vis, ok: true, why: null });
      if (ring.length > S.ringSize) ring.shift();
      return rec;
    },
  };
}

// ──────────────────── панорама между отсчётами ────────────────────

/**
 * Непрерывное слежение взгляда за телом.
 *
 * Здесь была экстраполяция по скорости: `u + скорость × возраст отсчёта`.
 * Выглядело разумно и оказалось главной ошибкой этапа. Возраст растёт от нуля
 * до 50 мс, а приход нового отсчёта сбрасывает его в ноль — то есть вид
 * уезжал вперёд и дёргался назад двадцать раз в секунду. Стоя это незаметно,
 * скорость около нуля; при смещении вбок получалась отчётливая тряска пола и
 * стен, от которой режет глаза и укачивает. Пожаловался на это ребёнок — то
 * есть цена ошибки здесь измеряется не в кадрах.
 *
 * Правильная форма — следящее сглаживание: кадр за кадром подтягиваться к
 * последнему отсчёту с постоянной времени. Оно непрерывно по построению,
 * разрывов не бывает вовсе, а отставание на больших движениях остаётся
 * небольшим и ровным.
 */
export function makeFollower(tauMs) {
  let value = null;
  return {
    get value() { return value ?? 0; },
    reset(v = 0) { value = v; },
    /** Шаг кадра: dt в секундах. */
    step(target, dt) {
      if (value === null) { value = target; return value; }
      // 1 - exp(-dt/tau): доля пути за этот кадр. Зависит от реального dt,
      // поэтому просадка частоты кадров не меняет ощущения.
      const k = 1 - Math.exp(-(dt * 1000) / Math.max(1, tauMs));
      value += (target - value) * k;
      return value;
    },
  };
}
