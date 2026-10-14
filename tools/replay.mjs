// Повторный прогон записанного скелета через нынешний код.
//
//   node tools/replay.mjs logs/run-game-log-2026-10-14-13-49-32.json
//
// Разбор: docs/log-and-storage.md, docs/presence-and-pause.md
//
// Зачем. `?record=1` пишет в журнал сырые точки скелета — отметку времени и
// 132 числа на отсчёт, — и шапка этой записи в js/train.js говорит прямо: это
// единственный способ тестировать распознавание, не держа ребёнка и камеру в
// цикле. Писатель был, читателя не было: каталог `fixtures/` стоял пустой, а
// на тринадцать снятых журналов пришлось НОЛЬ записей скелета. Шов был
// построен наполовину, и включать `?record=1` было незачем — прочесть запись
// всё равно было нечем.
//
// Что это даёт. Журнал с телефона становится проверкой: те же точки едут
// через `geometry` и `makeTracker`, что и в забеге, и видно, что нынешний код
// видит в той же записи. Два применения:
//
//   * РЕГРЕССИЯ. Правка в js/signals.js меняет число смен дорожки или причину
//     паузы на записи, снятой до правки, — это видно числом, а не ощущением.
//   * СВЕРКА С ТЕЛЕФОНОМ. В журнале рядом лежит то, что код решил ТОГДА
//     (события `gesture` и `pause`). Расхождение с тем, что он решает сейчас,
//     и есть ответ на вопрос «правка это починила или сломала».
//
// Чего он не делает: не судит препятствия и не считает очки. Приговор живёт в
// дирижёре, который из node не запускается вовсе, — это отдельная работа.
//
// Считалка отделена от печати намеренно, как в tools/log-report.mjs:
// `replay()` — чистая функция от разобранной сессии к числам, и ровно поэтому
// проверяется из node на синтетических сессиях. Группа «повторный прогон» в
// tests-control.mjs гоняет её на `fakeLandmarks`.

import { readFileSync } from 'node:fs';

import { makeTracker } from '../js/signals.js';
import { quantile, round } from '../js/util.js';
import { occurrences } from './log-report.mjs';

/** Отметка времени и 132 числа. Длина записи проверяется: короткая строка
    означала бы, что формат записи сменился, а читатель об этом не знает. */
const ROW = 133;

/* Окно забега: от перехода на стадию `free` до финиша.

   Без него сверка с журналом врёт, и врёт заметно. Запись идёт со всех
   стадий подряд, а трекер на телефоне ведётся только в забеге: установка
   штатива и калибровка идут своими путями (`onSetup`, `onCalibrate`) и смен
   дорожки не считают вовсе. Прогнанные через один трекер все строки подряд
   дали 42 смены против 24 в журнале — и это была бы не находка, а разница
   методик, выданная за расхождение.

   Границы берутся из событий, а не из догадки о длительности: `train.stage`
   с `to: "free"` и `run.finish`. Нет их — окна нет, берётся всё, и отчёт
   говорит об этом прямо. */
function windowOf(log) {
  const вход = log.find((e) => e.type === 'train.stage' && e.to === 'free');
  const финиш = log.find((e) => e.type === 'run.finish');
  if (!вход) return { from: -Infinity, to: Infinity, whole: true };
  return { from: вход.t, to: финиш ? (финиш._lastT ?? финиш.t) : Infinity, whole: false };
}

/** Строки скелета сессии, по порядку времени, в заданном окне. */
export function rowsOf(session, окно = { from: -Infinity, to: Infinity }) {
  const out = [];
  for (const e of session?.log || []) {
    if (e.type !== 'skeleton') continue;
    for (const r of e.rows || []) {
      if (!Array.isArray(r) || r.length !== ROW) continue;
      if (r[0] < окно.from || r[0] > окно.to) continue;
      out.push(r);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/* Отношение сторон кадра. Берётся из журнала, а не подразумевается единицей:
   на `geometry` оно влияет напрямую, и прогнать запись с чужим отношением —
   значит получить чужие числа и не заметить этого. */
function aspectOf(log) {
  for (const e of log) if (e.type === 'cam.aspect' && e.aspect) return e.aspect;
  return null;
}

/* Калибровка. Полностью она попадает в журнал только событием `calib.done`;
   при переиспользовании пишется одно `uEnter`, и восстановить остальное
   нечем. Поэтому возвращается ещё и то, откуда она взялась: прогон с
   умолчаниями — это другой прогон, и молчать об этом нельзя. */
function calibrationOf(log) {
  for (const e of log) {
    if (e.type !== 'calib.done') continue;
    return {
      from: 'calib.done',
      calibration: {
        uEnter: e.uEnter, vEnter: e.vEnter, S0: e.S0,
        excursion: e.excursion,
      },
    };
  }
  const load = log.find((e) => e.type === 'calib.load' && e.present);
  return { from: load ? 'calib.load (неполная)' : 'умолчания', calibration: {} };
}

/* Куски, которые запись реально покрывает.

   Нужны для сверки с журналом. Запись теперь бывает не сплошной, а всплесками
   по две секунды вокруг паузы и удара: три всплеска за сорокасекундный забег —
   это шесть секунд из сорока. Сравнивать девять смен дорожки, найденных в этих
   шести секундах, с сорока восемью из журнала всего забега — значит выдать
   разницу методик за расхождение кода. Ровно на этом инструмент уже попался
   однажды, когда прогонял все стадии против журнала одного забега.

   Кусок кончается там, где промежуток втрое больше обычного шага: тем же
   правилом, по которому считаются перерывы. */
function coverOf(rows, шаг) {
  if (!rows.length) return [];
  const куски = [[rows[0][0], rows[0][0]]];
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i][0] - rows[i - 1][0];
    if (шаг > 0 && d > шаг * 3) куски.push([rows[i][0], rows[i][0]]);
    else куски[куски.length - 1][1] = rows[i][0];
  }
  return куски;
}

/* Попадает ли событие в покрытое запись время.

   У склеенных событий (`_n`) все повторы приписываются куску, в котором лежит
   ПЕРВОЕ: распределить их точнее нечем, `_lastT` говорит только о конце
   потока. Для жестов это почти безразлично — у них разная полезная нагрузка,
   и склеиваются они редко. */
const covered = (куски, t) => куски.some(([a, b]) => t >= a && t <= b);

/** Сколько раз случилось событие такого вида в покрытое записью время. */
function countEvents(log, куски, type, pick = () => true) {
  let n = 0;
  for (const e of log) {
    if (e.type !== type || !pick(e)) continue;
    if (!covered(куски, e.t)) continue;
    n += occurrences(e);
  }
  return n;
}

/**
 * Прогнать записанный скелет через нынешний код.
 *
 * Возвращает числа, а не впечатления: сколько отсчётов, с какой частотой, что
 * получилось по смещению, сколько вышло смен дорожки и приседов, и по каким
 * причинам отсчёт не прошёл присутствие. Рядом — то же самое из журнала, то
 * есть решение кода на момент записи.
 */
export function replay(session) {
  const log = Array.isArray(session?.log) ? session.log : [];
  const окно = windowOf(log);
  const rows = rowsOf(session, окно);
  const aspect = aspectOf(log);
  const { from, calibration } = calibrationOf(log);

  const пусто = {
    n: 0, from, aspect, hz: null, перерывы: 0, покрытоС: 0, поводы: {}, whole: окно.whole,
    u: { med: null, p95: null, max: null },
    lanes: 0, crouches: 0, notPresent: 0, why: {},
    журнал: { lanes: 0, crouches: 0, pauses: 0, why: {} },
  };
  if (!rows.length) return пусто;

  const tracker = makeTracker(calibration, { aspect: aspect ?? 1 });
  const us = [];
  const why = {};
  let lanes = 0;
  let crouches = 0;
  let notPresent = 0;

  for (const row of rows) {
    const rec = tracker.push({ lm: row.slice(1), t: row[0] });
    if (!rec.ok) {
      notPresent++;
      why[rec.why] = (why[rec.why] || 0) + 1;
      continue;
    }
    us.push(Math.abs(rec.u));
    if (rec.laneChanged) lanes++;
    if (rec.crouchChanged && rec.crouch) crouches++;
  }

  const span = (rows[rows.length - 1][0] - rows[0][0]) / 1000;

  /* Частота — по МЕДИАНЕ промежутка, а не по размаху.

     Сперва здесь стояло `(n - 1) / span`: промежутков на один меньше, чем
     отсчётов, и тест на синтетике поймал, что `n / span` даёт 20.1 Гц вместо
     20. Теперь и этого мало. Запись можно включить посреди забега — настройка
     «Запись движений» читается живо, — и тогда в потоке дыра, которой размах
     не видит: двести отсчётов двумя кусками по десять секунд с перерывом в
     минуту дали бы 2.5 Гц. Число правдоподобное и неверное, а поехало бы оно
     в measurements/ как замер.

     Медиана к дырам нечувствительна по построению. Сами дыры при этом не
     прячутся, а считаются: промежуток втрое больше медианы — перерыв, и о нём
     надо знать, читая остальные числа. */
  const интервалы = [];
  for (let i = 1; i < rows.length; i++) интервалы.push(rows[i][0] - rows[i - 1][0]);
  const шаг = интервалы.length ? quantile(интервалы, 0.5) : 0;
  const перерывы = интервалы.filter((d) => шаг > 0 && d > шаг * 3).length;
  const куски = coverOf(rows, шаг);
  const покрытоС = куски.reduce((s, [a, b]) => s + (b - a), 0) / 1000;

  /* Чем вызван каждый всплеск. Берётся с самого события, а не выводится.

     Нужно потому, что происшествие случается ПОСЛЕ записи, а не внутри неё:
     всплеск — это две секунды ПЕРЕД паузой, и сама пауза в покрытое время не
     попадает. Сверка «паузы тогда» честно показывает ноль, и читается это как
     «пауз не было» — ровно наоборот. Поводы снимают вопрос: их не надо
     угадывать, игра их записала. */
  const поводы = {};
  for (const e of log) {
    if (e.type !== 'skeleton' || !e.why) continue;
    поводы[e.why] = (поводы[e.why] || 0) + 1;
  }

  /* Причины пауз из журнала — для сверки с `why` выше. Это НЕ одно и то же
     число: пауза наступает, когда отсчёты не проходят дольше `lostMs`, а
     здесь считаются сами отсчёты. Сравнивать надо состав причин, а не счёт. */
  const журналWhy = {};
  for (const e of log) {
    if (e.type !== 'pause' || !e.why || !covered(куски, e.t)) continue;
    журналWhy[e.why] = (журналWhy[e.why] || 0) + occurrences(e);
  }

  return {
    n: rows.length,
    from,
    aspect,
    // Окна не нашлось — строки взяты все, и сверка с журналом тогда неравная.
    whole: окно.whole,
    spanS: round(span, 1),
    hz: шаг > 0 ? round(1000 / шаг, 1) : null,
    перерывы,
    u: {
      med: us.length ? round(quantile(us, 0.5)) : null,
      p95: us.length ? round(quantile(us, 0.95)) : null,
      max: us.length ? round(Math.max(...us)) : null,
    },
    lanes,
    crouches,
    notPresent,
    why,
    покрытоС: round(покрытоС, 1),
    поводы,
    журнал: {
      lanes: countEvents(log, куски, 'gesture', (e) => ['left', 'right', 'center'].includes(e.kind)),
      crouches: countEvents(log, куски, 'gesture', (e) => e.kind === 'crouchIn'),
      pauses: countEvents(log, куски, 'pause'),
      why: журналWhy,
    },
  };
}

/** Строки отчёта. Печать отдельно от счёта — считалку проверяет тест. */
export function format(rep) {
  if (!rep.n) return 'записей скелета в сессии нет (нужен ?record=1 на забеге)';
  const доля = (k) => `${k} (${Math.round((k / rep.n) * 100)}%)`;
  const причины = (o) => (Object.keys(o).length
    ? Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')
    : '—');

  return [
    `отсчётов      ${rep.n} за ${rep.покрытоС} с записи, ${rep.hz} Гц`
      + (rep.перерывы
        ? `; ${rep.перерывы + 1} куска на отрезке ${rep.spanS} с — запись всплесками`
        : '')
      + (rep.whole ? '  (стадии забега в журнале нет — взяты все строки)' : ''),
    `кадр          отношение сторон ${rep.aspect ?? '— (в журнале нет)'}`,
    `калибровка    ${rep.from}`,
    `смещение |u|  медиана ${rep.u.med}, p95 ${rep.u.p95}, максимум ${rep.u.max}`,
    `дорожка       ${rep.lanes} смен · в журнале тогда ${rep.журнал.lanes}`
      + (rep.перерывы ? ' (и там, и там — только по покрытым кускам)' : ''),
    `присед        ${rep.crouches} · в журнале тогда ${rep.журнал.crouches}`,
    `не в кадре    ${доля(rep.notPresent)}: ${причины(rep.why)}`,
    ...(Object.keys(rep.поводы).length
      // Происшествие случается ПОСЛЕ своих двух секунд, поэтому в покрытое
      // время не попадает, и строка ниже о нём молчит. Поводы — попадают.
      ? [`всплески      ${причины(rep.поводы)}`]
      : [`паузы тогда   ${rep.журнал.pauses}: ${причины(rep.журнал.why)}`]),
  ].join('\n');
}

/** Сессии из выгруженного файла: формат тот же, что у tools/log-report.mjs. */
export function sessionsOf(dump) {
  if (Array.isArray(dump)) return dump;
  if (Array.isArray(dump?.sessions)) return dump.sessions;
  return [dump];
}

const прямойЗапуск = process.argv[1]
  && process.argv[1].replace(/\\/g, '/').endsWith('tools/replay.mjs');

if (прямойЗапуск) {
  const file = process.argv[2];
  if (!file) {
    console.error('укажите файл журнала: node tools/replay.mjs logs/run-game-log-….json');
    process.exit(1);
  }
  const sessions = sessionsOf(JSON.parse(readFileSync(file, 'utf8')));
  let сРаписью = 0;
  for (const [i, s] of sessions.entries()) {
    const rep = replay(s);
    if (!rep.n) continue;
    сРаписью++;
    console.log(`\nсессия ${i + 1} из ${sessions.length}   ${s.startedAt || ''}`);
    console.log(format(rep));
  }
  if (!сРаписью) {
    console.log(`\n${file}: записей скелета нет ни в одной из ${sessions.length} сессий.`);
    console.log('Запись включается параметром ?record=1 — около 0.5 МБ за полминуты.');
  }
}
