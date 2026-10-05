// Тренировка: дирижёр.
//
// Связывает источник поз, математику сигналов и панораму, ведёт стадии, паузу
// и отсчёт. Сам ничего не вычисляет — за каждым числом здесь стоит модуль,
// который проверяется без браузера.
//
// Стадии: установка штатива → калибровка → свободное движение. Препятствий и
// телеграфа пока нет: ребёнок обнаруживает, что вид едет за его телом, а мы
// снимаем числа, от которых зависит всё остальное.

import { SIGNALS as S, VIEW, POSE, CAMERA } from './config.js';
import { makeTracker, predict, geometry } from './signals.js';
import { createView, makeStars, canReach } from './view.js';
import { makeCalibration, load as loadCalibration, save as saveCalibration, isStale } from './calibrate.js';
import { framing } from './camera.js';
import { round } from './util.js';
import * as pose from './pose.js';
import * as log from './log.js';

const RUN = { running: 'running', paused: 'paused', countdown: 'countdown' };

export function createTraining({ canvas, video, onHud }) {
  const view = createView(canvas);
  let tracker = null;
  let source = null;
  let calibrator = null;
  let calibration = null;

  let stage = 'setup';
  let run = RUN.running;
  let raf = 0;
  let travel = 0;
  let stars = [];
  let score = 0;
  let lastFrame = 0;
  let pauseWhy = null;
  let countdownUntil = 0;
  let setupOk = false;

  // Последняя поза и момент её прихода: между отсчётами панорама живёт
  // предсказанием, иначе 20 Гц в 60 fps дают по три одинаковых кадра.
  let last = { u: 0, v: 0, speed: 0, t: 0 };
  let dim = 0;

  // Сводка здоровья копится секунду и уходит одним событием: писать каждую
  // позу — 24 МБ за сессию при потолке 25.
  const health = { frames: 0, poses: 0, ok: 0, infer: [], dropped: 0, since: 0, vis: 0, S: 0 };

  function hud(extra = {}) {
    onHud?.({ stage, run, why: pauseWhy, score, setupOk, ...extra });
  }

  function goStage(next) {
    log.event('train.stage', { from: stage, to: next });
    stage = next;
    if (next === 'calibrate') calibrator = makeCalibration();
    if (next === 'free') {
      stars = makeStars();
      travel = 0;
      score = 0;
      run = RUN.running;
    }
    hud();
  }

  // ───────────────────────── поток поз ─────────────────────────

  function onSample(sample) {
    const now = performance.now();
    health.poses++;
    health.dropped += sample.dropped || 0;
    if (sample.inferMs) health.infer.push(sample.inferMs);

    if (stage === 'setup') return onSetup(sample, now);
    if (stage === 'calibrate') return onCalibrate(sample, now);
    return onFree(sample, now);
  }

  function onSetup(sample, now) {
    const g = sample.lm ? geometry(sample.lm) : null;
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
    const r = calibrator.push(sample.lm, now);
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
      tracker = makeTracker(calibration);
      goStage('free');
      return;
    }
    if (r.retry) log.event('calib.retry', { stage: r.stage?.id, tries: r.tries });
    if (r.gaveUp) log.event('calib.fail', { stage: r.stage?.id });
    if (r.advanced) log.event('calib.stage', { stage: r.stage?.id });
    hud({ calib: r });
  }

  function onFree(sample, now) {
    const rec = tracker.push({ lm: sample.lm, t: now });
    if (rec.ok) {
      health.ok++;
      health.vis += rec.vis;
      health.S += rec.S;
      last = { u: rec.u, v: rec.v, speed: rec.speed, t: now };
      if (run === RUN.paused) beginCountdown(now);
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
    } else if (run === RUN.countdown) {
      // Пропал во время отсчёта — отсчёт отменяется, иначе игра поедет без
      // ребёнка.
      pause(rec);
    }
  }

  function pause(rec) {
    if (run === RUN.paused) return;
    run = RUN.paused;
    pauseWhy = rec.why;
    log.event('pause', {
      why: rec.why, vis: round(rec.vis ?? 0), S: round(rec.S ?? 0),
      cx: round(rec.cx ?? 0), lostMs: Math.round(rec.lostMs ?? 0),
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
      if (run === RUN.running) travel += VIEW.speed * dt;
    }

    // Панорама живёт предсказанием между отсчётами: интерполировать между ними
    // нельзя — это добавило бы целый период задержки единственному сигналу,
    // который мы обещали отдавать сразу.
    const u = predict(last.u, last.speed, now - last.t);
    const moving = stage === 'free' && run === RUN.running;
    dim += ((moving ? 0 : 0.55) - dim) * Math.min(1, dt * 6);

    if (stage === 'free') {
      for (const s of stars) {
        if (s.taken) continue;
        const z = s.z - travel;
        // Правило дотягивания живёт в одном месте вместе с отрисовкой: две
        // копии разошлись бы, и звёзды собирались бы не там, где их видно.
        if (z > 0 && z < 1.2 && canReach(s.x, u.value)) {
          s.taken = true;
          score++;
          log.event('star', { side: Math.sign(s.x), u: round(u.value) });
          hud();
        }
      }
    }

    view.render({ u: u.value, v: last.v, travel, stars, dim });
    if (now - health.since > 1000) flushHealth(now, u.clamped);
  }

  function flushHealth(now, clamped) {
    const span = (now - health.since) / 1000;
    health.since = now;
    if (!span || !health.frames) return;
    const infer = [...health.infer].sort((a, b) => a - b);
    log.event('health', {
      stage,
      fps: Math.round(health.frames / span),
      hz: Math.round(health.poses / span),
      drop: health.dropped,
      ok: round(health.poses ? health.ok / health.poses : 0),
      vis: round(health.ok ? health.vis / health.ok : 0),
      S: round(health.ok ? health.S / health.ok : 0),
      p50: infer.length ? Math.round(infer[Math.floor(infer.length / 2)]) : 0,
      p95: infer.length ? Math.round(infer[Math.floor(infer.length * 0.95)]) : 0,
      u: round(last.u),
      v: round(last.v),
      clamped: clamped ? 1 : 0,
    });
    health.frames = 0; health.poses = 0; health.ok = 0; health.dropped = 0;
    health.vis = 0; health.S = 0; health.infer = [];
  }

  return {
    get stage() { return stage; },
    get run() { return run; },
    get score() { return score; },
    get why() { return pauseWhy; },
    get source() { return source; },

    /** Вручную шагнуть со стадии установки дальше. */
    next() {
      if (stage === 'setup') goStage('calibrate');
    },

    async start({ source: src, script, skipSetup = false }) {
      calibration = loadCalibration();
      tracker = makeTracker(calibration || {});
      travel = 0; score = 0; dim = 0; lastFrame = 0;
      health.since = performance.now();

      source = await pose.start({ source: src, script, hz: POSE.hz, onSample });

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
      // ребёнок не пройдёт — он не слушается. Поэтому сразу в движение;
      // калибровка при этом остаётся доступной через ?stage=calibrate.
      goStage(src === 'fake' || skipSetup ? 'free' : 'setup');
      raf = requestAnimationFrame(frame);
      return source;
    },

    async stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      await pose.stop();
      if (video) video.srcObject = null;
      source = null;
      log.event('train.stage', { from: stage, to: 'idle' });
    },
  };
}
