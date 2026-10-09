// Тренировка: дирижёр.
//
// Связывает источник поз, математику сигналов и панораму, ведёт стадии, паузу
// и отсчёт. Сам ничего не вычисляет — за каждым числом здесь стоит модуль,
// который проверяется без браузера.
//
// Стадии: установка штатива → калибровка → свободное движение. Препятствий и
// телеграфа пока нет: ребёнок обнаруживает, что вид едет за его телом, а мы
// снимаем числа, от которых зависит всё остальное.

import { SIGNALS as S, VIEW, POSE, OBSTACLES as O, FINISH as FIN } from './config.js';
import { makeTracker, makeFollower, geometry } from './signals.js';
import { createView, makeStars, makeDecor, canReach } from './view.js';
import { MOTION } from './theme.js';
import {
  makeCalibration, load as loadCalibration, save as saveCalibration, isStale, panSpanOf,
  forReuse,
} from './calibrate.js';
import { framing, frameAspect } from './camera.js';
import { drawSkeleton, updateField } from './preview.js';
import { makeLevel, isSafe, telegraph } from './level.js';
import * as audio from './audio.js';
import { settings } from './settings.js';
import { cameraX } from './view.js';
import { round, flag, quantile } from './util.js';
import * as pose from './pose.js';
import * as log from './log.js';

const RUN = { running: 'running', paused: 'paused', countdown: 'countdown' };

/**
 * Счёт забега: собранные кольца, очки и число задетых препятствий.
 *
 * Разведено на три числа намеренно. Один счётчик на кольца и очки уже соврал:
 * удар вычитал starsLost из того же числа, которым считается собранное, и
 * экран результата говорил «88 колец из 100» про забег, в котором собрано
 * было 90 (журнал 7 октября, 90 событий сбора при одном задетом препятствии).
 * Из ста колец недобранными выглядели двенадцать вместо десяти, а рекорды
 * разных забегов становились несравнимы ровно по тому полю, ради которого
 * таблица и ведётся.
 *
 * Отнимание кольца за удар при этом остаётся — это обратная связь, счётчик в
 * HUD уходит вниз, и так решено заказчиком. В HUD идут `score`, в результат и
 * в рекорд — `collected`.
 *
 * Живёт отдельной функцией, чтобы проверяться из node: весь остальной счёт
 * заперт внутри кадрового цикла, который без браузера не запустить.
 */
export function makeTally({ starsLost = 0 } = {}) {
  let collected = 0;
  let score = 0;
  let hits = 0;
  return {
    get collected() { return collected; },
    get score() { return score; },
    get hits() { return hits; },
    star() { collected++; score++; },
    hit() {
      hits++;
      // Ниже нуля счётчик в HUD опускаться не должен. Собранное зажимать
      // нечем и незачем — оно только растёт.
      score = Math.max(0, score - starsLost);
    },
    reset() { collected = 0; score = 0; hits = 0; },
  };
}

export function createTraining({ canvas, video, skeleton, field, fieldMark, onHud }) {
  /* Фон неба растром. Грузится без ожидания: пока картинки нет, `drawSky`
     рисует плоские полосы и силуэт холмов, и игра работает полностью. Так и
     задумано — арт собирается отдельным прогоном Easy Diffusion, и забег не
     должен от него зависеть. Ошибка загрузки тоже ничего не ломает: у
     незагруженной картинки `width` равен нулю, а именно это и проверяется.

     Путь абсолютный, от модуля: относительный разрешался бы от того, кто
     вызывает, и на телефоне выяснилось бы, что он указывает не туда. */
  const backdrop = new Image();
  backdrop.src = new URL('../assets/sky.webp', import.meta.url).href;

  const view = createView(canvas, { backdrop });
  let tracker = null;
  let source = null;
  let calibrator = null;
  let calibration = null;

  let stage = 'setup';
  let run = RUN.running;
  let raf = 0;
  let travel = 0;
  let elapsed = 0;     // секунд забега; по нему живёт весь телеграф
  let stars = [];
  let obstacles = [];
  const tally = makeTally({ starsLost: O.starsLost });
  let invulnUntil = 0;
  let flash = 0;
  let decor = [];
  let lastSpeed = 0;   // боковая скорость; по ней бадники решают, икать ли
  let durationS = 240;
  let result = null;
  let lastFrame = 0;
  let pauseWhy = null;
  let countdownUntil = 0;
  let setupOk = false;
  /* Ручная пауза отличается от автопаузы тем, что сама не кончается. Автопауза
     снимается, как только ребёнка снова видно, — а нажатую взрослым снимать
     по появлению ребёнка в кадре нельзя: он из кадра и не уходил. */
  let manual = false;

  // Последняя поза — цель, за которой взгляд едет непрерывно. Именно
  // непрерывно: экстраполяция по скорости, стоявшая здесь раньше, давала
  // разрыв на каждом новом отсчёте, и вид дёргался двадцать раз в секунду.
  let last = { u: 0, v: 0, t: 0 };
  // Последняя поза как есть — для окошка камеры. Рисуется она в кадре, а не
  // в приходе отсчёта: иначе скелет мигал бы на 20 Гц поверх видео, идущего
  // на 30, и выглядело бы это хуже, чем отсутствие скелета.
  let lastLm = null;
  let lastOk = false;
  let lastCx = null;
  let lastGeom = null;
  // Цель калибровки для окошка камеры: куда ребёнку надо попасть. Живёт здесь,
  // потому что кадр отрисовки и кадр позы — разные, и рисовать надо последнюю
  // известную цель, а не ту, что совпала с кадром.
  let lastTarget = null;
  /* Отношение сторон кадра. Без него x и y меряются в разных единицах, и
     ширина плеч выходит вдвое меньше настоящей — ребёнок, стоящий лицом,
     читается как повёрнутый боком. Берём у источника, а не угадываем. */
  let aspect = 16 / 9;
  const followU = makeFollower(VIEW.followMs);
  const followV = makeFollower(VIEW.followMs);
  let dim = 0;

  // Сводка здоровья копится секунду и уходит одним событием: писать каждую
  // позу — 24 МБ за сессию при потолке 25.
  const health = { frames: 0, poses: 0, ok: 0, infer: [], draw: [], dropped: 0, since: 0, vis: 0, S: 0 };

  /* Остановлено ли снаружи. Нужен потому, что `start()` долгий и его можно
     прервать посередине — см. комментарий у самого `start()`. */
  let stopped = false;

  /* Запись сырых точек скелета — для фикстур.
     По умолчанию выключена и включается через ?record=1: на 20 Гц это около
     полумегабайта за полминуты, а весь потолок журнала — 25 МБ. Пишется
     пачками по двадцать отсчётов, иначе одних только заголовков событий
     набежало бы больше, чем самих данных. Уходит обычной выгрузкой журнала —
     отдельной кнопки не нужно.

     Эти записи проверяют всё, что происходит ПОСЛЕ MediaPipe, и это
     единственный способ тестировать распознавание, не держа ребёнка и камеру
     в цикле. */
  const recording = flag('record') !== null;
  let batch = [];

  function recordSkeleton(sample, now) {
    if (!sample.lm) return;
    const row = new Array(133);
    row[0] = Math.round(now);
    for (let i = 0; i < 132; i++) row[i + 1] = Math.round(sample.lm[i] * 1000) / 1000;
    batch.push(row);
    if (batch.length >= 20) {
      log.event('skeleton', { n: batch.length, rows: batch });
      batch = [];
    }
  }

  /* Полезная нагрузка HUD.

     `result` подмешивается ВСЕГДА, а не только из finish(). Пока он уходил
     одним вызовом, экран результата обнулялся сам собой: любой следующий
     hud() — с автопаузы, с отсчёта, со смены камеры, с возврата из
     родительского меню — приходил без этого поля, и app.js рисовал
     `result?.stars ?? 0`, то есть «0 колец собрано / 0 раз задел». В журнале
     это видно прямо: `run.finish stars:102` и через 3.8 секунды
     `pause why:"scale"`. Выглядело как сброс данных по таймеру, а было
     потерей поля. */
  function hud(extra = {}) {
    onHud?.({
      stage, run, why: pauseWhy, score: tally.score, setupOk, manual, result,
      source: source?.kind || null,
      progress: durationS ? Math.min(1, elapsed / durationS) : 0,
      ...extra,
    });
  }

  function goStage(next) {
    log.event('train.stage', { from: stage, to: next });
    stage = next;
    if (next === 'calibrate') calibrator = makeCalibration({ aspect });
    if (next === 'free') {
      /* Длина забега. Параметр адреса сильнее всего, затем режим ускоренной
         отладки, затем родительская настройка: ждать пять минут на каждую
         проверку экрана финиша бессмысленно. */
      durationS = Number(flag('run'))
        || (settings.get('debug') === 'fast' ? 30 : 0)
        || settings.get('runLength')
        || 300;
      /* Препятствия ПЕРВЫМИ: кольца расставляются уже зная о них.

         Раньше оба расписания строились независимо, и в журнале первого
         полного забега одиннадцать колец оказались ближе 0.35 с к
         препятствию. Поменять эти две строки местами — значит вернуть кольца,
         которые нельзя собрать, не ударившись. */
      obstacles = makeLevel({ durationS, crouch: settings.get('crouch') });
      stars = makeStars({ durationS, obstacles });
      decor = makeDecor({ durationS });
      travel = 0;
      elapsed = 0;
      tally.reset();
      result = null;
      invulnUntil = 0;
      run = RUN.running;
      /* Политика экрана телефона едет в журнал вместе с забегом. Без неё два
         забега одной сессии неразличимы при разборе, а замер ровно в том и
         состоит, чтобы сравнить их внутри ОДНОЙ сессии: разброс устройства
         ±8 fps живёт между сессиями и съел бы весь эффект. */
      log.event('run.start', {
        durationS, obstacles: obstacles.length, stars: stars.length,
        screenRun: settings.get('screenRun'),
      });
    }
    hud();
  }

  // ───────────────────────── поток поз ─────────────────────────

  /* Форма кадра пересверяется на КАЖДОЙ позе, а не берётся один раз при
     открытии камеры.

     Второй забег 8 октября: камера открылась через 91 мс после поворота
     экрана, `getSettings()` отдал портрет вместо ландшафта, и это одно число
     сделало игру непроходимой — ширина плеч к торсу вышла 0.27 при пороге
     0.45, то есть «повернись к телевизору» навсегда. Разбор и доказательство,
     что врал отчёт дорожки, а не камера повернулась, — в `frameAspect`.

     Сверка стоит два чтения свойства, а правка уходит в живые трекер и
     калибровку: пересоздавать их посреди забега значит терять нейтраль,
     защёлкнутую дорожку и присед. */
  function syncAspect(sample) {
    const a = frameAspect({ sample, video: source?.video, settings: source?.settings });
    if (!(a > 0) || Math.abs(a - aspect) < 0.01) return;
    /* Три источника формы кадра едут в журнал РЯДОМ, а не по одному.

       8 октября соврали оба по очереди: утром `getSettings()` отдал портрет
       при ландшафтных кадрах, вечером кадры повернулись по-настоящему, а
       отчёт остался ландшафтным. Пока в записи стояло одно число, отличить
       эти случаи было нечем, а разошедшееся видео против кадра означает ещё и
       скелет не на своём месте — у окошка `object-fit: cover`. */
    log.event('cam.aspect', {
      aspect: round(a, 2), was: round(aspect, 2),
      w: sample?.w ?? source?.video?.videoWidth ?? null,
      h: sample?.h ?? source?.video?.videoHeight ?? null,
      videoW: source?.video?.videoWidth ?? null,
      videoH: source?.video?.videoHeight ?? null,
      said: source?.settings?.width && source?.settings?.height
        ? round(source.settings.width / source.settings.height, 2) : null,
    });
    aspect = a;
    tracker?.setAspect?.(a);
    calibrator?.setAspect?.(a);
  }

  function onSample(sample) {
    const now = performance.now();
    syncAspect(sample);
    health.poses++;
    health.dropped += sample.dropped || 0;
    if (sample.inferMs) health.infer.push(sample.inferMs);
    if (recording) recordSkeleton(sample, now);

    lastLm = sample.lm;
    if (stage === 'setup') return onSetup(sample, now);
    if (stage === 'calibrate') return onCalibrate(sample, now);
    /* На экране результата присутствие не судим.

       Забег кончился, ребёнок отходит от камеры — и onFree честно объявлял
       автопаузу поверх цифр результата: «Отойди немного назад» на экране, где
       отходить ровно и надо. Судить тут нечего: игры больше нет. */
    if (stage === 'result') return undefined;
    return onFree(sample, now);
  }

  function onSetup(sample, now) {
    const g = sample.lm ? geometry(sample.lm, aspect) : null;
    lastOk = !!g && g.vis >= S.visMin;
    lastCx = g ? g.cx : null;
    lastGeom = g;
    const f = framing(source?.settings, g);
    setupOk = !!g && f.ok && g.vis >= S.visMin;
    if (g) { health.ok++; health.vis += g.vis; health.S += g.S; }
    hud({
      framing: f,
      vis: g ? round(g.vis) : 0,
      settings: source?.settings || null,
      pipeline: source?.pipeline || null,
    });
  }

  function onCalibrate(sample, now) {
    const g = sample.lm ? geometry(sample.lm, aspect) : null;
    lastOk = !!g && g.vis >= S.visMin;
    lastCx = g ? g.cx : null;
    const r = calibrator.push(sample.lm, now);

    /* Повтор и провал пишутся ДО разбора `done`, а не после.

       Иначе теряется ровно тот случай, ради которого всё это: сдавшаяся
       последняя стадия (присед) приходит с `done` и `failed` одновременно, и
       запись о провале оставалась за `return`. В журнале это выглядело бы как
       благополучная `calib.done` с порогом приседа по нижнему зажиму и без
       объяснения, откуда он взялся. */
    if (r.retry) log.event('calib.retry', { stage: r.stage?.id, tries: r.tries });
    // Провал называется по ПРОВАЛИВШЕЙСЯ стадии: в `stage` к этому моменту
    // уже следующая, и журнал врал бы именем.
    if (r.failed) log.event('calib.fail', { stage: r.failed.id });

    if (r.done) {
      calibration = r.result;
      saveCalibration(calibration);
      log.event('calib.done', {
        uEnter: round(calibration.uEnter), vEnter: round(calibration.vEnter),
        S0: round(calibration.S0), excursion: {
          left: round(calibration.excursion.left),
          right: round(calibration.excursion.right),
          crouch: round(calibration.excursion.crouch),
        },
      });
      tracker = makeTracker(calibration, { aspect });
      goStage('free');
      return;
    }
    if (r.advanced) log.event('calib.stage', { stage: r.stage?.id });
    lastTarget = r.target ?? null;
    hud({ calib: r });
  }

  function onFree(sample, now) {
    const rec = tracker.push({ lm: sample.lm, t: now });
    lastOk = rec.ok;
    lastCx = rec.cx ?? null;
    if (rec.ok) {
      lastSpeed = rec.speed ?? 0;
      health.ok++;
      health.vis += rec.vis;
      health.S += rec.S;
      /* Боковое смещение приводится к РАЗМАХУ ЭТОГО ИГРОКА, а не остаётся в
         длинах торса. Отсюда и дальше (панорама, дотягивание до кольца,
         уклонение) всё живёт в долях игрового поля, и приведение обязано быть
         ровно здесь, в одном месте: ниже `u` расходится на три дороги, и две
         копии нормировки означали бы, что ребёнок бьётся о то, чего не видит.

         Зачем вообще — журнал первого забега ребёнка: шаг взрослого даёт
         ≈0.48 единицы u, шаг ребёнка ≈0.34, и ребёнку нужно вдвое больше
         шагов на то же решение. Подробности и потолок усиления — у PAN_SPAN
         в js/calibrate.js. */
      last = { u: rec.u / panSpanOf(calibration), v: rec.v, t: now };
      if (run === RUN.paused && !manual) beginCountdown(now);
      if (rec.laneChanged) {
        log.event('gesture', {
          kind: rec.lane === 0 ? 'center' : rec.lane < 0 ? 'left' : 'right',
          uRaw: round(rec.uRaw), u: round(rec.u), speed: round(rec.speed),
        });
      }
      if (rec.crouchChanged) {
        log.event('gesture', { kind: rec.crouch ? 'crouchIn' : 'crouchOut', v: round(rec.v), votes: rec.votes });
      }
    } else if (run === RUN.running && rec.lostMs > S.lostMs) {
      pause(rec);
    } else if (run === RUN.countdown && rec.lostMs > S.lostMs) {
      /* Пропал во время отсчёта — отсчёт отменяется, иначе игра поедет без
         ребёнка. Но судить это надо ТЕМ ЖЕ порогом, что и вход в паузу.

         Без `lostMs` ветка срывала отсчёт от единственного плохого отсчёта
         позы, а вернуться в отсчёт можно с первой же хорошей — и у порога
         присутствия получалось автоколебание с периодом в один-два отсчёта.
         `countdownUntil` при каждом обороте ставился заново, то есть отсчёт не
         доходил до конца, пока дребезг не кончится. В журнале 6 октября это
         185.5 → 193.5 с: ребёнок смотрел «3-2-1» дважды, 8 секунд, а всего
         паузы съели 28.5 с из 332. */
      pause(rec);
    }
  }

  function pause(rec) {
    if (run === RUN.paused) return;
    run = RUN.paused;
    pauseWhy = rec.why;
    /* `ratio` и `shW` — не для полноты. Три журнала подряд `profile` был
       главной причиной пауз (7, 8 и ещё 8 эпизодов), и ни один из них не мог
       сказать, ПОЧЕМУ: решение принимается по отношению ширины плеч к торсу, а
       в журнал уходили только видимость, торс и центр. Разбор упирался в
       догадки о форме кадра, о расстоянии и о том, повернулся ребёнок или нет.
       Теперь в записи стоит само число, с которым сравнивали порог, и рядом
       форма кадра — второй подозреваемый по тем же журналам.

       `sLo`/`sHi` — то же самое для причины `scale`, и по тому же журналу:
       9 октября восемь таких пауз разбирались вручную, доставанием `S0` из
       другого события и умножением на коэффициент. Теперь это и вовсе не
       сошлось бы — у потолка появился пол, одним умножением он не выводится.
       Полоса спрашивается у трекера в момент паузы, а не едет в каждой
       записи. */
    const [sLo, sHi] = tracker.scaleBand?.() ?? [null, null];
    log.event('pause', {
      why: rec.why, vis: round(rec.vis ?? 0), S: round(rec.S ?? 0),
      cx: round(rec.cx ?? 0), lostMs: Math.round(rec.lostMs ?? 0),
      ratio: rec.shoulderRatio != null ? round(rec.shoulderRatio) : null,
      shW: rec.shoulderWidth != null ? round(rec.shoulderWidth) : null,
      sLo: sLo != null ? round(sLo) : null,
      sHi: sHi != null ? round(sHi) : null,
      aspect: round(aspect, 2),
    });
    // Две секунды отсчётов вокруг происшествия — одним событием. Именно по ним
    // потом разбирается жалоба «встало на паузу само».
    const burst = tracker.burst(2000);
    if (burst.length) {
      log.event('samples', {
        n: burst.length,
        rows: burst.map((r) => [Math.round(r.t), round(r.u), round(r.v), round(r.S), round(r.vis)]),
      });
    }
    hud();
  }

  function beginCountdown(now) {
    if (run !== RUN.paused) return;
    run = RUN.countdown;
    countdownUntil = now + S.resumeMs + S.countdown * 1000;
    log.event('countdown', { n: S.countdown });
    hud();
  }

  // ───────────────────────── кадры ─────────────────────────

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    health.frames++;

    if (stage === 'free') {
      if (run === RUN.countdown && now >= countdownUntil) {
        run = RUN.running;
        pauseWhy = null;
        log.event('resume', {});
        hud();
      }
      if (run === RUN.running) {
        travel += VIEW.speed * dt;
        // Время забега идёт только пока бежим: на паузе препятствия не
        // должны проезжать мимо ребёнка, которого нет в кадре, — и финиш не
        // должен приближаться, пока он вышел попить воды.
        elapsed += dt;
        if (elapsed >= durationS) finish();
      }
    }

    // Взгляд догоняет тело кадр за кадром. Непрерывно по построению —
    // разрывов, от которых тряслись стены, здесь быть не может.
    const u = followU.step(last.u, dt);
    const v = followV.step(last.v, dt);
    const moving = stage === 'free' && run === RUN.running;
    dim += ((moving ? 0 : 0.55) - dim) * Math.min(1, dt * 6);

    if (stage === 'free') stepObstacles(now, u);

    if (stage === 'free') {
      for (const s of stars) {
        if (s.taken) continue;
        const z = s.z - travel;
        // Правило дотягивания живёт в одном месте вместе с отрисовкой: две
        // копии разошлись бы, и звёзды собирались бы не там, где их видно.
        if (z > 0 && z < 1.2 && canReach(s.x, u)) {
          s.taken = true;
          s.takenAtS = elapsed;
          tally.star();
          log.event('star', { side: Math.sign(s.x), u: round(u) });
          audio.play('star');
          hud();
        }
      }
    }

    flash = Math.max(0, flash - dt * 2.2);
    /* Время одной отрисовки идёт в журнал.

       Нужно, чтобы не чинить вслепую. В журнале 6 октября частота поз осела
       до 11 Гц при цели 20, а медиана инференса выросла с 62 до 93 мс — ровно
       после того, как у первого уровня появился арт. Правдоподобных объяснений
       два: отрисовка отнимает GPU у распознавания, либо дело вообще не в ней.
       Различить их может только замер, а не рассуждение, поэтому следующий
       журнал будет содержать оба числа рядом. */
    const drawStart = performance.now();
    view.render({
      decor,
      speed: lastSpeed,
      u, v, travel, stars, obstacles, elapsed,
      finishIn: stage === 'free' ? durationS - elapsed : null,
      safe: lastSafe,
      pulse: (now / 220) % 2 < 1 ? 1 : 0,
      dim: Math.min(1, dim + flash),
    });
    health.draw.push(performance.now() - drawStart);
    if (skeleton && !skeleton.parentElement?.hidden) {
      drawSkeleton(skeleton, lastLm, lastOk,
        stage === 'calibrate' ? lastTarget : null, aspect);
    }
    if (field && !field.hidden) updateField(field, fieldMark, lastOk ? lastCx : null);
    if (now - health.since > 1000) {
      flushHealth(now);
      // Полоса до финиша — единственное в HUD, что меняется само по себе.
      // Обновлять её каждый кадр незачем, раз в секунду достаточно.
      if (stage === 'free') hud();
    }
  }

  /* Препятствия: телеграф, столкновение и окно прощения.

     Опоздание на треть секунды прощается задним числом — и в первом лице это
     вообще незаметно, потому что персонажа, который уже стукнулся, на экране
     нет. Первое лицо здесь работает на нас. */
  let lastSafe = true;

  function stepObstacles(now, u) {
    const camX = cameraX(u);
    const crouching = tracker?.crouch ?? false;
    lastSafe = true;

    for (const ob of obstacles) {
      if (ob.passed) continue;
      const dt = ob.at - elapsed;
      if (dt > O.signalS) break; // список по времени — дальше смотреть незачем

      const safe = isSafe(ob, { camX, crouching });
      // Стадии телеграфа считает level.js — та же функция, что проверяется
      // тестами. Повторять её условия здесь значило бы завести вторую копию
      // расписания, которая однажды разойдётся с проверенной.
      const phase = telegraph(dt);

      // Звук за четыре секунды: он говорит, что именно делать, и приходит
      // раньше картинки — у динамика телефона задержки нет.
      if (!ob.announced && phase.signal) {
        ob.announced = true;
        audio.play(audio.motifFor(ob));
        /* `look` в журнале — не для полноты. Перекраска не меняет ни действия,
         ни приговора, но вполне может читаться хуже: силуэт, который ребёнок
         не узнаёт, даст лишние задетые препятствия, и отличить это от усталости
         можно будет только по журналу. Поэтому вид едет рядом с видом задачи. */
      log.event('telegraph', { kind: ob.kind, look: ob.look ?? null, side: ob.side, at: round(ob.at, 1) });
      }

      // Пока препятствие в последней секунде, его состояние правит подсветку.
      // И звучит один раз: подтверждение, если стоишь правильно, или
      // предупреждение, если нет. Подтверждение не менее важно — в первом
      // лице нет персонажа, по которому видно, достаточно ли ты ушёл.
      if (phase.lastCall) {
        lastSafe = safe;
        if (!ob.calledAt) {
          ob.calledAt = now;
          audio.play(safe ? 'ready' : 'warn');
        }
      }

      if (!phase.arrived) continue;

      // Пришло. Либо сразу засчитываем проход, либо открываем окно прощения.
      if (safe) {
        ob.passed = true;
        audio.play('clear');
        log.event('obstacle', { kind: ob.kind, look: ob.look ?? null, side: ob.side, result: 'clear', camX: round(camX) });
      } else if (ob.verdictAt === null) {
        ob.verdictAt = now + O.lateForgiveMs;
      } else if (now >= ob.verdictAt) {
        ob.passed = true;
        // Решение запоминается до того, как мы выставим неуязвимость:
        // иначе в журнал всегда уходило бы «прощено».
        const counted = now > invulnUntil;
        if (counted) {
          ob.hit = true;
          tally.hit();
          invulnUntil = now + O.invulnMs;
          flash = MOTION.flashPeak;
          audio.play('hit');
          hud();
        }
        log.event('obstacle', {
          kind: ob.kind, look: ob.look ?? null, side: ob.side,
          result: counted ? 'hit' : 'grace',
          camX: round(camX), crouch: crouching,
        });
      }
    }
  }

  /* Финиш. Забег кончается по времени, а не по числу препятствий: ребёнку
     обещана полоса прогресса, и она должна дойти до конца ровно тогда, когда
     показывает. */
  function finish() {
    /* В результат идёт СОБРАННОЕ, а не очки.

       Это разные числа: удар вычитает starsLost из очков, и пока результат
       брал их, «88 колец из 100» означало забег, в котором собрано было 90.
       Очки едут рядом отдельным полем — без них журнал не может объяснить
       число, которое ребёнок видел в HUD на финише. */
    const collected = tally.collected;
    const hits = tally.hits;
    result = {
      stars: collected,
      score: tally.score,
      // Сколько колец вообще было. Без этого числа рекорд несравним даже
      // внутри одной длины: уровень сеян случайно, и колец в нём то 99, то
      // 103. «102 из 130» говорит то, чего «102» не говорит.
      starsTotal: stars.length,
      hits,
      durationS,
      // Похвала всегда положительная и всегда разная по степени, но никогда
      // не отрицательная: проигрыша в этой игре нет, и экран результата не
      // место, где он появится.
      praise: hits === 0 ? 'Ни разу не задел!'
        : collected >= hits * 4 ? 'Отличный забег!'
          : 'Добежал!',
    };
    stage = 'result';
    log.event('run.finish', {
      stars: collected, score: tally.score, starsTotal: stars.length, hits,
      durationS: Math.round(durationS),
    });
    audio.play('finish');
    // Без аргумента намеренно: result теперь уходит из hud() всегда, и
    // передавать его здесь ещё раз значило бы намекать, что это единственный
    // путь — именно так и возник обнуляющийся экран результата.
    hud();
  }

  function flushHealth(now) {
    const span = (now - health.since) / 1000;
    health.since = now;
    if (!span || !health.frames) return;
    const infer = health.infer;
    const draw = health.draw;
    log.event('health', {
      stage,
      fps: Math.round(health.frames / span),
      hz: Math.round(health.poses / span),
      drop: health.dropped,
      ok: round(health.poses ? health.ok / health.poses : 0),
      vis: round(health.ok ? health.vis / health.ok : 0),
      S: round(health.ok ? health.S / health.ok : 0),
      p50: infer.length ? Math.round(quantile(infer, 0.5)) : 0,
      p95: infer.length ? Math.round(quantile(infer, 0.95)) : 0,
      // Отрисовка рядом с инференсом: по этой паре видно, кто кого ждёт.
      draw50: draw.length ? Math.round(quantile(draw, 0.5)) : 0,
      draw95: draw.length ? Math.round(quantile(draw, 0.95)) : 0,
      u: round(last.u),
      v: round(last.v),
      /* Чем поделено `u`. С этим полем журнал объясняет сам себя: здесь `u` в
         долях ИГРОВОГО ПОЛЯ, а в событии `gesture` — в длинах торса. Перепутать
         их легко, а разбор забега строится ровно на сравнении этих чисел между
         ребёнком и взрослым. Нет поля — журнал от сборки до нормировки поля. */
      panSpan: round(panSpanOf(calibration)),
    });
    health.frames = 0; health.poses = 0; health.ok = 0; health.dropped = 0;
    health.vis = 0; health.S = 0; health.infer = []; health.draw = [];
  }

  return {
    get stage() { return stage; },
    get run() { return run; },
    get score() { return tally.score; },
    get why() { return pauseWhy; },
    get result() { return result; },
    get source() { return source; },

    /**
     * Переключить камеру и перезапустить распознавание.
     *
     * Перезапуск нужен целиком: facingMode задаётся при открытии дорожки, и
     * поменять его у уже открытой нельзя. Калибровка при этом сбрасывается —
     * другая камера это другая сцена, и прежние пороги описывают уже не её.
     */
    async switchCamera() {
      const next = settings.cycle('camera');
      log.event('cam.switch', { to: settings.get('camera') });
      calibration = null;
      await pose.stop();
      source = await pose.start({ source: 'camera', hz: POSE.hz, onSample });
      if (video && source.video) {
        video.srcObject = source.video.srcObject;
        video.play?.().catch(() => {});
      }
      hud();
      return next;
    },

    /** Остановить забег по просьбе человека. */
    pauseManual() {
      if (stage !== 'free' || manual) return;
      manual = true;
      run = RUN.paused;
      pauseWhy = null;
      log.event('pause', { why: 'manual', elapsed: round(elapsed, 1) });
      hud();
    },

    /**
     * Снять ручную паузу — через тот же отсчёт, что и после автопаузы.
     * Ребёнку надо дать время вернуться на место: он отходил, пока стояла
     * пауза, и бросать его сразу под препятствие нечестно.
     */
    resumeManual() {
      if (!manual) return;
      manual = false;
      beginCountdown(performance.now());
    },

    /**
     * Шаг со стадии установки дальше.
     *
     * Калибровку переигрывать каждый раз незачем: она занимает двадцать
     * секунд, а ребёнок хочет бежать. Поэтому прошлая принимается, если сцена
     * та же. А если штатив сдвинули или ребёнок стоит заметно дальше, прошлые
     * пороги описывают уже не его — и тогда калибровка обязательна.
     */
    next() {
      if (stage !== 'setup') return;
      const stale = isStale(calibration, lastGeom);
      const reuse = !!calibration && !stale;
      log.event('calib.reuse', { reuse, had: !!calibration, stale });
      goStage(reuse ? 'free' : 'calibrate');
    },

    /* Запуск долгий: камера открывается почти две секунды, прогрев модели ещё
       три. Всё это время экран забега уже показан, и уйти с него можно — с
       появлением кнопки «Назад» это стало обычным делом. Поэтому `stop()`
       умеет случиться ПОСРЕДИ `start()`, и один флаг здесь важнее, чем
       выглядит: без него `pose.stop()` не делает ничего (источника ещё нет в
       `pose.js`), а `start()` после await спокойно доводит дело до конца —
       включает камеру, вешает цикл кадров и уходит в стадию. Снаружи это
       «вернулись в меню, а камера горит», и остановить её больше нечем:
       ссылку на тренировку приложение уже обнулило. Второй запуск добавил бы
       второй цикл и второй источник поз на тот же канвас. */
    async start({ source: src, script, skipSetup = false }) {
      stopped = false;
      calibration = loadCalibration();
      /* В трекер — БЕЗ нейтрали (`forReuse`): прошлая снята в прошлой сцене, и
         от неё отсчитывается присед. Сама `calibration` остаётся целой — её
         нейтраль нужна `isStale`, чтобы заметить сдвинутый штатив. */
      tracker = makeTracker(forReuse(calibration) || {}, { aspect });
      travel = 0; tally.reset(); dim = 0; lastFrame = 0;
      health.since = performance.now();

      source = await pose.start({ source: src, script, hz: POSE.hz, onSample });
      // Ушли с экрана, пока открывалась камера. Гасим то, что уже успело
      // завестись, и дальше не идём: цикл кадров не вешаем вовсе.
      if (stopped) { await pose.stop(); source = null; return null; }
      // Отношение сторон — у камеры настоящее, у синтетики то, под которое
      // нарисован её скелет.
      const st = source?.settings;
      aspect = frameAspect({ video: source?.video, settings: st });
      tracker = makeTracker(forReuse(calibration) || {}, { aspect });
      log.event('cam.aspect', {
        aspect: round(aspect, 2),
        w: source?.video?.videoWidth ?? null, h: source?.video?.videoHeight ?? null,
        said: st?.width && st?.height ? round(st.width / st.height, 2) : null,
        saidW: st?.width ?? null, saidH: st?.height ?? null,
      });

      // Предпросмотр: у синтетики камеры нет, и показывать нечего.
      if (video && source.video) {
        video.srcObject = source.video.srcObject;
        video.play?.().catch(() => {});
      }

      log.event('calib.load', {
        present: !!calibration,
        uEnter: calibration ? round(calibration.uEnter) : null,
      });

      // У синтетики штатив наводить не на что, а калибровку синтетический
      // ребёнок не пройдёт — он не слушается. Поэтому сразу в движение.
      // Но экран калибровки надо чем-то проверять, и камеры для этого может
      // не быть вовсе: ?stage=calibrate открывает его на синтетике.
      const forced = flag('stage');
      const first = forced && ['setup', 'calibrate', 'free'].includes(forced)
        ? forced
        : (src === 'fake' || skipSetup ? 'free' : 'setup');
      goStage(first);
      raf = requestAnimationFrame(frame);
      return source;
    },

    async stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      raf = 0;
      if (batch.length) { log.event('skeleton', { n: batch.length, rows: batch }); batch = []; }
      await pose.stop();
      if (video) video.srcObject = null;
      source = null;
      log.event('train.stage', { from: stage, to: 'idle' });
    },
  };
}
