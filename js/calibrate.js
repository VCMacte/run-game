// Калибровка — она же первое обучение.
//
// Пороги не задаются константой, а берутся из того размаха, который ребёнок
// реально показал: половина от него, с ограничением сверху и снизу. Так они
// подгоняются и под телосложение, и под то, как на самом деле стоит штатив, —
// надёжнее любого числа, выбранного заранее. А ребёнок попутно узнаёт, какие
// движения от него нужны, и видит, что игра на них отвечает.
//
// Автомат без DOM: стадии и числа здесь, показ — в train.js. Поэтому всё
// проверяется обычным скриптом node.

import { SIGNALS as S, STORAGE } from './config.js';
import { clamp } from './util.js';
import { geometry } from './signals.js';

export const STAGES = [
  { id: 'neutral', say: 'Встань в рамку и постой', ms: 5000 },
  { id: 'left', say: 'Шагни влево!', ms: 4000 },
  { id: 'right', say: 'Шагни вправо!', ms: 4000 },
  { id: 'crouch', say: 'Присядь как лягушка!', ms: 4000 },
];

// Границы, за которые порог не пускаем ни при каком размахе. Снизу — чтобы
// дрожание распознавания не стало «жестом»; сверху — чтобы жест вообще был
// достижим для ребёнка, который в азарте показал размах вдвое больше
// обычного.
export const CLAMP = {
  u: [0.30, 0.70],
  v: [0.25, 0.55],
};

/* Меньший размах считается «не пошевелился» и просит повторить: порог,
   выведенный из дрожания, был бы не порогом, а случайным числом. */
const MIN_EXCURSION = { u: 0.25, v: 0.20 };

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE.calibration) || 'null');
    return raw && raw.neutralX != null ? raw : null;
  } catch {
    return null;
  }
}

export function save(cal) {
  try { localStorage.setItem(STORAGE.calibration, JSON.stringify(cal)); } catch {}
}

export function clear() {
  try { localStorage.removeItem(STORAGE.calibration); } catch {}
}

/**
 * Сдвинулся ли штатив с прошлого раза.
 *
 * Если нейтраль или длина торса уехали заметно — калибровка описывает уже не
 * ту сцену, и лучше попросить пройти её заново, чем молча играть с чужими
 * порогами.
 */
export function isStale(cal, g, tolerance = 0.25) {
  if (!cal || !g) return false;
  const dS = Math.abs(g.S - cal.S0) / cal.S0;
  const dX = Math.abs(g.cxh - cal.neutralX) / g.S;
  return dS > tolerance || dX > tolerance * 2;
}

/**
 * Автомат калибровки.
 *
 * `push(lm, t)` возвращает состояние: текущая стадия, что говорить ребёнку,
 * сколько осталось, и — на последней — готовую калибровку.
 */
export function makeCalibration({ aspect = 1 } = {}) {
  let stage = 0;
  let since = null;
  let tries = 0;
  const neutral = { x: 0, shoulderY: 0, hipY: 0, S: 0, n: 0 };
  let best = { left: 0, right: 0, crouch: 0 };
  let result = null;

  const mean = () => ({
    neutralX: neutral.x / neutral.n,
    neutralShoulderY: neutral.shoulderY / neutral.n,
    neutralHipY: neutral.hipY / neutral.n,
    S0: neutral.S / neutral.n,
  });

  function finish() {
    const base = mean();
    // Половина показанного размаха: ребёнок не обязан каждый раз повторять
    // рекорд, а дрожание до половины не дотянет.
    const uEnter = clamp(Math.min(best.left, best.right) / 2, ...CLAMP.u);
    const vEnter = clamp(best.crouch / 2, ...CLAMP.v);
    result = {
      ...base,
      uEnter,
      uExit: uEnter * (S.uExit / S.uEnter), // та же пропорция, что в умолчаниях
      vEnter,
      vExit: vEnter * (S.vExit / S.vEnter),
      excursion: { ...best },
      at: new Date().toISOString(),
    };
    return result;
  }

  return {
    get stage() { return STAGES[stage]; },
    get index() { return stage; },
    get result() { return result; },
    get tries() { return tries; },

    push(lm, t) {
      const st = STAGES[stage];
      if (!st) return { done: true, result };

      if (!lm) return { stage: st, say: 'Тебя не видно — встань в рамку', hold: 0, waiting: true };
      const g = geometry(lm, aspect);
      if (g.vis < S.visMin) {
        return { stage: st, say: 'Тебя плохо видно', hold: 0, waiting: true };
      }

      if (since === null) since = t;
      const hold = t - since;

      if (st.id === 'neutral') {
        neutral.x += g.cxh; neutral.shoulderY += g.shoulderY;
        neutral.hipY += g.hipY; neutral.S += g.S; neutral.n++;
      } else {
        const base = mean();
        if (st.id === 'crouch') {
          best.crouch = Math.max(best.crouch, (g.shoulderY - base.neutralShoulderY) / g.S);
        } else {
          const u = S.mirrorX * (g.cxh - base.neutralX) / g.S;
          if (st.id === 'left' && u < 0) best.left = Math.max(best.left, -u);
          if (st.id === 'right' && u > 0) best.right = Math.max(best.right, u);
        }
      }

      if (hold < st.ms) {
        return { stage: st, say: st.say, hold, progress: hold / st.ms };
      }

      // Стадия вышла по времени — принимаем или просим повторить.
      const got = st.id === 'neutral' ? neutral.n
        : st.id === 'crouch' ? best.crouch
          : st.id === 'left' ? best.left : best.right;
      const need = st.id === 'neutral' ? 20
        : st.id === 'crouch' ? MIN_EXCURSION.v : MIN_EXCURSION.u;

      if (got < need) {
        tries++;
        since = null;
        // Три попытки — и идём дальше с умолчанием: застрять на калибровке
        // хуже, чем играть с неидеальным порогом. Ребёнок не должен упереться
        // в экран, с которого нет выхода.
        if (tries >= 3) { stage++; return { stage: st, retry: false, gaveUp: true }; }
        return { stage: st, retry: true, say: st.id === 'crouch' ? 'Ещё ниже!' : 'Ещё дальше!', tries };
      }

      stage++;
      since = null;
      tries = 0;
      if (stage >= STAGES.length) return { done: true, result: finish() };
      return { stage: STAGES[stage], say: STAGES[stage].say, hold: 0, advanced: true };
    },
  };
}
