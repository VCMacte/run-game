// Тренировка: дирижёр.
//
// Связывает источник поз, математику сигналов и панораму, ведёт паузу и
// отсчёт. Сам ничего не вычисляет — за каждым числом здесь стоит модуль,
// который проверяется без браузера.
//
// Пока это свободное движение без препятствий: ребёнок обнаруживает, что вид
// едет за его телом, а мы снимаем числа, от которых зависит всё остальное.
// Телеграф и препятствия придут следующей частью, после проверки на ребёнке.

import { SIGNALS as S, VIEW, POSE } from './config.js';
import { makeTracker, predict } from './signals.js';
import { createView, makeStars, cameraX } from './view.js';
import { clamp, round } from './util.js';
import * as pose from './pose.js';
import * as log from './log.js';

const STATE = { idle: 'idle', running: 'running', paused: 'paused', countdown: 'countdown' };

export function createTraining({ canvas, onHud }) {
  const view = createView(canvas);
  let tracker = null;
  let source = null;

  let state = STATE.idle;
  let raf = 0;
  let travel = 0;
  let stars = [];
  let score = 0;
  let lastFrame = 0;
  let pauseWhy = null;
  let countdownUntil = 0;

  // Последняя поза и момент её прихода: между отсчётами панорама живёт
  // предсказанием, иначе 20 Гц в 60 fps дают по три одинаковых кадра.
  let last = { u: 0, v: 0, speed: 0, t: 0 };
  let dim = 0;

  // Сводка здоровья копится секунду и уходит в журнал одним событием:
  // писать каждую позу — 24 МБ за сессию при потолке 25.
  const health = { frames: 0, poses: 0, ok: 0, infer: [], dropped: 0, since: 0, vis: 0, S: 0 };

  function onSample(sample) {
    const now = performance.now();
    health.poses++;
    health.dropped += sample.dropped || 0;
    if (sample.inferMs) health.infer.push(sample.inferMs);

    const rec = tracker.push({ lm: sample.lm, t: now });
    if (rec.ok) {
      health.ok++;
      health.vis += rec.vis;
      health.S += rec.S;
      last = { u: rec.u, v: rec.v, speed: rec.speed, t: now };
      if (state === STATE.paused) beginCountdown(now);
      if (rec.laneChanged) {
        log.event('gesture', {
          kind: rec.lane === 0 ? 'center' : rec.lane < 0 ? 'left' : 'right',
          uRaw: round(rec.uRaw), u: round(rec.u), speed: round(rec.speed),
        });
      }
      if (rec.crouchChanged) {
        log.event('gesture', { kind: rec.crouch ? 'crouchIn' : 'crouchOut', v: round(rec.v), votes: rec.votes });
      }
    } else if (state === STATE.running && rec.lostMs > S.lostMs) {
      pause(rec);
    } else if (state === STATE.countdown) {
      // Пропал во время отсчёта — отсчёт отменяется, иначе игра поедет без
      // ребёнка.
      pause(rec);
    }
  }

  function pause(rec) {
    if (state === STATE.paused) return;
    state = STATE.paused;
    pauseWhy = rec.why;
    log.event('pause', {
      why: rec.why, vis: round(rec.vis ?? 0), S: round(rec.S ?? 0),
      cx: round(rec.cx ?? 0), lostMs: Math.round(rec.lostMs ?? 0),
    });
    // Две секунды отсчётов вокруг происшествия — одним событием. Именно по
    // ним потом разбирается жалоба «встало на паузу само».
    const burst = tracker.burst(2000);
    if (burst.length) {
      log.event('samples', {
        n: burst.length,
        rows: burst.map((r) => [Math.round(r.t), round(r.u), round(r.v), round(r.S), round(r.vis)]),
      });
    }
    onHud?.({ state, why: rec.why, score });
  }

  function beginCountdown(now) {
    if (state !== STATE.paused) return;
    state = STATE.countdown;
    countdownUntil = now + S.resumeMs + S.countdown * 1000;
    log.event('countdown', { n: S.countdown });
    onHud?.({ state, score });
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    health.frames++;

    if (state === STATE.countdown && now >= countdownUntil) {
      state = STATE.running;
      pauseWhy = null;
      log.event('resume', {});
      onHud?.({ state, score });
    }

    const moving = state === STATE.running;
    if (moving) travel += VIEW.speed * dt;

    // Панорама живёт предсказанием между отсчётами: интерполировать между
    // ними нельзя — это добавило бы целый период задержки единственному
    // сигналу, который мы обещали отдавать сразу.
    const age = now - last.t;
    const u = predict(last.u, last.speed, age);
    const v = last.v;

    dim += ((moving ? 0 : 0.55) - dim) * Math.min(1, dt * 6);

    // Звёзды собираются, когда доехали до игрока и ребёнок на их стороне.
    for (const s of stars) {
      if (s.taken) continue;
      const z = s.z - travel;
      if (z > 0 && z < 1.2) {
        // Та же формула, что и в отрисовке — через общий cameraX: две копии
        // разошлись бы, и звёзды собирались бы не там, где их видно.
        if (Math.abs(s.x - cameraX(u.value)) < VIEW.corridorWidth * 0.33) {
          s.taken = true;
          score++;
          log.event('star', { side: Math.sign(s.x), u: round(u.value) });
          onHud?.({ state, score });
        }
      }
    }

    view.render({ u: u.value, v, travel, stars, dim });

    if (now - health.since > 1000) flushHealth(now, u.clamped);
  }

  function flushHealth(now, clamped) {
    const span = (now - health.since) / 1000;
    health.since = now;
    if (!span || !health.frames) return;
    const infer = health.infer;
    infer.sort((a, b) => a - b);
    log.event('health', {
      fps: Math.round(health.frames / span),
      hz: Math.round(health.poses / span),
      drop: health.dropped,
      ok: round(health.poses ? health.ok / health.poses : 0),
      vis: round(health.ok ? health.vis / health.ok : 0),
      S: round(health.ok ? health.S / health.ok : 0),
      p50: infer.length ? Math.round(infer[Math.floor(infer.length / 2)]) : 0,
      u: round(last.u),
      v: round(last.v),
      predictClamped: clamped ? 1 : 0,
      state,
    });
    health.frames = 0; health.poses = 0; health.ok = 0; health.dropped = 0;
    health.vis = 0; health.S = 0; health.infer = [];
  }

  return {
    get state() { return state; },
    get score() { return score; },
    get why() { return pauseWhy; },

    async start({ source: src, script, calibration }) {
      tracker = makeTracker(calibration || {});
      stars = makeStars();
      travel = 0; score = 0; dim = 0;
      state = STATE.running;
      lastFrame = 0;
      health.since = performance.now();
      log.event('train.stage', { to: 'free', source: src });

      source = await pose.start({ source: src, script, hz: POSE.hz, onSample });
      raf = requestAnimationFrame(frame);
      return source;
    },

    async stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      state = STATE.idle;
      await pose.stop();
      source = null;
      log.event('train.stage', { to: 'idle' });
    },
  };
}
