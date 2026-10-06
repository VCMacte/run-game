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

import { SIGNALS as S } from './config.js';
import { clamp } from './util.js';
import { geometry } from './signals.js';
import { players } from './players.js';

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
  u: [0.25, 0.60],
  // Потолок приседа опущен вслед за долей: 0.55 ребёнок в игре не показывал
  // ни разу, и присед просто не срабатывал.
  v: [0.20, 0.45],
};

/* Меньший размах считается «не пошевелился» и просит повторить: порог,
   выведенный из дрожания, был бы не порогом, а случайным числом. */
const MIN_EXCURSION = { u: 0.25, v: 0.20 };

/* Калибровка принадлежит игроку, а не телефону.

   Раньше она лежала одной записью на устройство, и взрослый с ребёнком
   затирали её друг другу: тот, кто играл вторым, проходил двадцать секунд
   калибровки заново при каждом забеге. Угадать по длине торса, кто перед
   камерой, нельзя — у неё систематический разброс (0.53 на калибровке против
   0.40 в забеге по журналу), и любой порог либо пропускает чужого, либо
   отвергает своего. Поэтому хранилище спрашивает игрока: js/players.js.

   Три функции остались на месте, потому что их зовут train.js и app.js, и им
   незачем знать, где именно она лежит. */

export function load() {
  return players.loadCalibration();
}

export function save(cal) {
  players.saveCalibration(cal);
}

export function clear() {
  players.clearCalibration();
}

/* Два допуска, и они про разное — поэтому и названы по отдельности, а не
   выведены один из другого множителем, как было.

   scale: допуск по длине торса. Прежние 25% не проходили ни разу — в журнале
   это видно прямо: calib.reuse reuse:false had:true stale:true. На калибровке
   торс 0.53, в забеге 0.35–0.48, расхождение 26–46%, и причина не в шуме:
   игрок возится у телефона, пока идёт установка, и отходит только к забегу.
   Кто перед камерой, теперь определяет выбранный профиль, а не размер тела,
   поэтому допуск можно сделать честно широким.

   neutral: допуск по смещению нейтрали, в долях торса. Его как раз ослаблять
   нельзя — это и есть сдвинутый штатив, ради которого проверка существует. */
export const STALE = { scale: 0.45, neutral: 0.5 };

/**
 * Сдвинулся ли штатив с прошлого раза — или перед камерой другая сцена.
 *
 * Если нейтраль или длина торса уехали заметно, калибровка описывает уже не
 * ту сцену, и лучше попросить пройти её заново, чем молча играть с чужими
 * порогами.
 */
export function isStale(cal, g, limit = STALE) {
  if (!cal || !g) return false;
  const dS = Math.abs(g.S - cal.S0) / cal.S0;
  const dX = Math.abs(g.cxh - cal.neutralX) / g.S;
  return dS > limit.scale || dX > limit.neutral;
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

  /* Какую долю показанного размаха брать за порог.

     Была половина, и по журналу с телефона это оказалось слишком много. На
     калибровке ребёнок показывает размах напоказ — замерено 1.14, 0.90 и 1.05
     при трёх стадиях, — а в игре двигается вдвое скромнее: наибольшее
     смещение за весь забег 0.46 при пороге 0.45. То есть порог стоял ровно на
     границе достижимого, а присед не сработал ни разу: оба верхних
     препятствия задеты.

     Треть показанного — то, до чего ребёнок дотягивается в игре, а не на
     показательном выступлении. */
  const FRACTION = 0.35;

  function finish() {
    const base = mean();
    const uEnter = clamp(Math.min(best.left, best.right) * FRACTION, ...CLAMP.u);
    const vEnter = clamp(best.crouch * FRACTION, ...CLAMP.v);
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
