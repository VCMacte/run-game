// Разбор журнала, выгруженного с телефона.
//
//   node tools/log-report.mjs logs/run-game-log-2026-10-06-18-19-23.json
//
// Журнал — единственный свидетель забега с ребёнком, и читать его глазами
// нельзя: полмегабайта и до двадцати сессий в одном файле. Здесь он
// превращается в те несколько чисел, по которым правятся оценки в
// `js/config.js`: достижимая частота поз, время инференса, доля собранных
// колец, доля пауз и их причины.
//
// Считалка отделена от печати намеренно: `report()` — чистая функция от
// разобранного JSON к числам, и ровно поэтому она проверяется из node, без
// телефона и без настоящего журнала. Группа «разбор журнала» в
// `tests-control.mjs` гоняет её на синтетических сессиях.

import { OBSTACLES } from '../js/config.js';

import { readFileSync } from 'node:fs';
import { count, TIMES } from '../js/text.js';

/* Сколько раз случилось событие. Повторы подряд журнал склеивает в одну
   запись со счётчиком `_n` (см. `js/log.js`), и считать записи вместо разов —
   главная ловушка этого файла: у ребёнка одна ошибка в кадре дала 1478
   событий и одну строку. Разница между «упало один раз» и «упало 1478 раз»
   здесь и есть весь смысл разбора. */
/* Окно телеграфа в миллисекундах. Берётся из `js/config.js`, а не вписано
   числом: это то самое число, которое разбор и призван проверить, и вторая его
   копия означала бы, что отчёт сверяет журнал сам с собой. */
const SIGNAL_MS = OBSTACLES.signalS * 1000;

export function occurrences(e) {
  return Math.max(1, e?._n || 1);
}

/** Когда событие перестало повторяться. Для одиночного — когда случилось. */
function lastT(e) {
  return e?._lastT ?? e?.t ?? 0;
}

/** Последняя отметка времени во всём журнале, с учётом склеенных потоков. */
function endOf(log) {
  let end = 0;
  for (const e of log) end = Math.max(end, lastT(e));
  return end;
}

function round(x, digits = 0) {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}

/* Медиана, а не среднее: окна здоровья приходят раз в несколько секунд, и
   одно плохое окно не должно утянуть всю картину. */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function max(xs) { return xs.length ? Math.max(...xs) : null; }
function min(xs) { return xs.length ? Math.min(...xs) : null; }

function pick(log, type) {
  return log.filter((e) => e?.type === type);
}

/**
 * Числа одной сессии журнала.
 *
 * Сессия — это один запуск приложения: `{ id, startedAt, ua, log: [...] }`.
 * Возвращается структура, а не текст: печать живёт отдельно, в `format()`.
 */
export function report(session) {
  const log = Array.isArray(session?.log) ? session.log : [];
  const notes = [];
  const end = endOf(log);

  // ── источник поз ──
  /* Берётся ПОСЛЕДНЕЕ событие: камеру за сеанс могли переключить, и тогда
     действующий конвейер описан последней записью, а не первой. */
  const ready = pick(log, 'pose.ready').at(-1) ?? null;
  const pose = {
    pipeline: ready?.pipeline ?? null,
    // Заявленный делегат умеет врать; рядом с ним всегда едет время прогрева,
    // потому что честный ответ про GPU даёт только оно.
    delegate: ready?.delegate ?? null,
    initMs: ready?.initMs ?? null,
    warmupP50: ready?.warmupP50 ?? null,
    looksLikeCpu: ready?.looksLikeCpu ?? null,
    cam: ready?.cam ?? null,
  };

  // ── производительность по окнам здоровья ──
  const windows = pick(log, 'health');
  /* Склеенное окно — это несколько окон, и весить оно обязано как несколько.
     Здесь был разнобой: `drop` считался с учётом `_n`, а медианы и число окон
     — без, и один журнал давал несогласованные между собой числа. Стоящий
     ребёнок даёт одинаковые окна буквально: все значения в `health` округлены,
     так что склейка на них срабатывает. */
  const nums = (key) => windows.flatMap((w) => (typeof w?.[key] === 'number'
    ? Array(occurrences(w)).fill(w[key])
    : []));
  /* Квантили в `health` посчитаны ВНУТРИ окна, и усреднять их нельзя: среднее
     квантилей — не квантиль. Поэтому отчёт показывает медиану окон и худшее
     окно отдельно, и подписывает это ровно так. Сказать «p50 по забегу» из
     этих данных значило бы соврать числом. */
  const perf = {
    windows: windows.reduce((s, w) => s + occurrences(w), 0),
    infer: { med: median(nums('p50')), worst: max(nums('p95')) },
    draw: { med: median(nums('draw50')), worst: max(nums('draw95')) },
    hz: { med: median(nums('hz')), worst: min(nums('hz')) },
    fps: { med: median(nums('fps')), worst: min(nums('fps')) },
    drop: windows.reduce((s, w) => s + (w?.drop || 0) * occurrences(w), 0),
    ok: median(nums('ok')),
    vis: median(nums('vis')),
    S: median(nums('S')),
  };

  /* Ширина игрового поля. Её отсутствие — не ноль, а «журнал снят до
     нормировки поля»: ноль здесь означал бы поле нулевой ширины, и число
     поехало бы в measurements/ как настоящее. */
  const withSpan = windows.filter((w) => typeof w?.panSpan === 'number');
  const panSpan = withSpan.length ? withSpan.at(-1).panSpan : null;
  if (panSpan === null) {
    notes.push('нет panSpan: журнал снят со сборки до нормировки игрового поля');
  }

  // ── итоги забега ──
  const finish = pick(log, 'run.finish').at(-1) ?? null;
  const obstacles = { clear: 0, grace: 0, hit: 0, total: 0, byLook: {} };
  for (const e of pick(log, 'obstacle')) {
    const n = occurrences(e);
    obstacles.total += n;
    if (e.result === 'hit') obstacles.hit += n;
    else if (e.result === 'grace') obstacles.grace += n;
    else obstacles.clear += n;
    /* Разбивка по ВНЕШНОСТИ препятствия, а не только по виду.

       Внешность не меняет ни действия, ни приговора — но вполне может читаться
       хуже: силуэт, который ребёнок не узнаёт, даст лишние задетые. Отличить
       это от усталости можно только здесь, сравнив доли у двух внешностей
       одного действия. У журналов до перекрасок поля нет, и тогда разбивки
       просто не будет — это честнее, чем сваливать всё в «неизвестно». */
    if (typeof e.look === 'string') {
      const key = `${e.kind || '?'}/${e.look}`;
      const b = obstacles.byLook[key] || (obstacles.byLook[key] = { total: 0, hit: 0 });
      b.total += n;
      if (e.result === 'hit') b.hit += n;
    }
  }

  /* ── время реакции ──

     Главный незакрытый вопрос проекта: все числа телеграфа и скоростей в
     `js/config.js` — ОЦЕНКИ, и так там написано с самого начала. Пересчитать
     их можно только по забегу с ребёнком, и забег 10 октября дал первый
     журнал без единого дефекта, то есть первые данные, которым можно верить.

     Считается две РАЗНЫЕ вещи, и путать их нельзя.

     `think` — от отметки телеграфа до жеста. Это время ответа ребёнка, и
     именно с ним сравнивается `OBSTACLES.signalS`: окно решения не вправе
     быть короче ответа.

     `lead` — от жеста до прохода препятствия. Это то, что осталось, и оно
     показывает, насколько близко к краю ребёнок играет.

     Присед идёт отдельной медианой. Он по построению делается ПОЗЖЕ бокового
     шага — его держат недолго, и начинать заранее незачем, — так что общая
     медиана прятала бы оба числа сразу.

     Препятствие без подходящего жеста в счёт не идёт вовсе: ребёнок мог уже
     стоять на безопасной стороне с прошлого раза, и приписать ему нулевое
     время ответа значило бы занизить медиану выдумкой. По той же причине
     жест ДО отметки телеграфа не считается — это не реакция на неё. */
  const reaction = (() => {
    const gestures = pick(log, 'gesture');
    const marks = pick(log, 'telegraph');
    const think = [];
    const lead = [];
    const duckLead = [];
    for (const ob of pick(log, 'obstacle')) {
      /* Отметка — последняя ПЕРЕД проходом, но не любая: окно телеграфа
         конечно, и отметка старше его к этому препятствию не относится.

         Проверка нужна не для красоты. Журнал 9 октября половину забега
         простоял на ложных паузах, часть отметок в него не попала, и
         «последняя перед» подобралась от ПРЕДЫДУЩЕГО препятствия: вышло
         «думал 9.52 с» при окне телеграфа 5.0 — число, невозможное по
         построению, но с виду правдоподобное. Такое в measurements/ уехало бы
         как измерение.

         Запас четверть окна — на дрожание журнала: отметка пишется в кадре
         отрисовки, а кадр идёт 39 раз в секунду при распознавании 12. */
      const mark = marks.filter((m) => m.t < ob.t && ob.t - m.t <= SIGNAL_MS * 1.25).at(-1);
      if (!mark) continue;
      const need = ob.kind === 'duck' ? 'crouchIn' : (ob.side > 0 ? 'left' : 'right');
      // Последний подходящий жест в окне телеграфа: ребёнок может качнуться и
      // вернуться, а решает последнее движение.
      const g = gestures.filter((x) => x.t > mark.t && x.t < ob.t && x.kind === need).at(-1);
      if (!g) continue;
      think.push(round((g.t - mark.t) / 1000, 2));
      const l = round((ob.t - g.t) / 1000, 2);
      lead.push(l);
      if (ob.kind === 'duck') duckLead.push(l);
    }
    /* Медиана чётной выборки — среднее двух средних, то есть лишняя цифра
       после запятой. Здесь она не просто некрасива: число уезжает в
       measurements/ и читается как измеренное с точностью до миллисекунды,
       которой у распознавания в 12 Гц нет и быть не может. */
    const со = (xs) => (xs.length ? round(median(xs), 2) : null);
    return {
      n: think.length,
      thinkMed: со(think),
      thinkMax: max(think),
      leadMed: со(lead),
      leadMin: min(lead),
      duckLeadMed: со(duckLead),
    };
  })();

  /* Нет `run.finish` — забег брошен, и считать его забегом с нулём колец
     нельзя. Это та же логика, по которой в таблицу рекордов попадает только
     дошедший до финиша: не фильтром, а отсутствием записи. */
  const finished = !!finish;
  if (!finished) notes.push('забег брошен: run.finish в журнале нет');

  /* ── разбивка по забегам сессии ──

     `perf` выше считается по ВСЕЙ сессии, и для одного забега этого хватало. А
     замер экрана телефона состоит ровно в том, чтобы сравнить два забега
     внутри одной сессии: разброс устройства ±8 fps живёт между сессиями, и
     сравнивать журналы между собой бессмысленно. Общая медиана смешала бы обе
     политики в одно число, то есть ответила бы на вопрос замера средним по
     вопросу.

     Поэтому каждому `run.start` — своё окно: от него до следующего запуска или
     до конца журнала. Калибровка и меню, попавшие между забегами, в окно
     входят, и это честнее, чем вырезать их по стадиям: политика экрана
     действует на весь забег, а стадии внутри него меняются. */
  const runs = pick(log, 'run.start').map((st, i, all) => {
    const to = i + 1 < all.length ? all[i + 1].t : end;
    const own = windows.filter((w) => w.t >= st.t && w.t <= to);
    const ownNums = (key) => own.flatMap((w) => (typeof w?.[key] === 'number'
      ? Array(occurrences(w)).fill(w[key])
      : []));
    /* Настройка — это ПРОСЬБА, а не наблюдение, и путать их дорого: 8 октября
       экран гас в обоих забегах, включая тот, где просили не гаснуть, а сводка
       бодро печатала «экран не гаснет», потому что читала настройку. Поэтому
       рядом едет то, что случилось с блокировкой на самом деле: сколько раз её
       не стало втихую и сколько раз её брали заново. */
    // `e?.type`, как и весь обход в этом файле: на входе — файл с телефона, и
    // одна битая запись не должна убивать весь разбор.
    const wake = log.filter((e) => e?.type === 'wakelock' && e.t >= st.t && e.t <= to);
    const сколько = (f) => wake.filter(f).reduce((a, e) => a + occurrences(e), 0);
    return {
      at: st.t,
      durationS: st.durationS ?? null,
      screenRun: typeof st.screenRun === 'string' ? st.screenRun : null,
      wakeLost: сколько((e) => e.released === true && e.why === 'system'),
      wakeRegained: сколько((e) => e.got === true && e.why === 'regain'),
      windows: own.reduce((a, w) => a + occurrences(w), 0),
      fps: median(ownNums('fps')),
      hz: median(ownNums('hz')),
      infer: median(ownNums('p50')),
    };
  });

  /* Запуск, которому принадлежит этот финиш. В сессии их бывает несколько, и
     замер политики экрана стоит ровно на этом: два забега подряд в одной
     сессии, и каждому нужен свой `run.start`, а не первый попавшийся. */
  const start = finish
    ? (pick(log, 'run.start').filter((s) => s.t <= finish.t).at(-1) ?? null)
    : null;

  const run = finished
    ? {
      durationS: finish.durationS ?? null,
      /* Политика экрана телефона: 'awake' — блокировка держится, 'sleep' —
         отпущена на время забега. Нет поля — журнал снят до замера, и врать
         догадкой здесь нечем. */
      screenRun: start && typeof start.screenRun === 'string' ? start.screenRun : null,
      // Собранные кольца. С 7 октября это именно они: до правки одно поле
      // значило и кольца, и очки, и при задетом препятствии показывало очки.
      stars: finish.stars ?? 0,
      /* Очки — кольца минус отнятое за удары, то есть цифра с экрана ребёнка.
         Нет поля вовсе — журнал снят до разделения, и тогда очков мы не знаем;
         null, а не копия колец: копия выдала бы догадку за измерение. */
      score: Number.isFinite(finish.score) ? finish.score : null,
      starsTotal: finish.starsTotal ?? 0,
      // Доля считается по КОЛЬЦАМ: удар к собираемости отношения не имеет.
      ringPct: finish.starsTotal ? Math.round((finish.stars / finish.starsTotal) * 100) : null,
      // Задетое берётся из `run.finish`: он здесь источник, а вторая копия
      // числа рано или поздно разошлась бы с первой.
      hits: finish.hits ?? 0,
      obstacles,
      // «Чисто» — это не задето, то есть чистые ВМЕСТЕ с прощёнными: окно
      // прощения на то и дано, чтобы ребёнок успел уйти.
      cleanPct: obstacles.total
        ? Math.round(((obstacles.total - obstacles.hit) / obstacles.total) * 100)
        : null,
    }
    : null;

  // ── паузы ──
  const pauses = {
    episodes: 0, totalS: 0, inRunS: 0, pctOfRun: null, byWhy: {}, unclosed: 0,
    profileRatio: { lo: null, hi: null },
    scaleBand: { sLo: null, sHi: null, lo: null, hi: null },
  };

  /* Пауза кончается ПЕРВЫМ из: `resume`, следующей паузы, начала или обрыва
     забега, конца журнала. Границы здесь не формальность: в одной сессии
     забегов несколько, и пока искался просто «следующий resume в сессии»,
     пауза брошенного забега находила `resume` СЛЕДУЮЩЕГО забега и
     проглатывала всё между ними. Хуже всего, что при этом пауза считалась
     закрытой — то есть оговорка «сеанс кончился на паузе» не печаталась, и
     завышенная доля уезжала в measurements/ как настоящее число. */
  const spans = [];
  let open = null;
  const closeAt = (e, at, closed) => spans.push({ t: e.t, end: Math.max(at, e.t), closed });
  for (const e of log) {
    if (e?.type === 'pause') {
      if (open) closeAt(open, e.t, false);
      open = e;
      const n = occurrences(e);
      pauses.episodes += n;
      const why = e.why || 'неизвестно';
      pauses.byWhy[why] = (pauses.byWhy[why] || 0) + n;
      /* Отношение плеч к торсу у пауз `profile`. Три журнала подряд эта
         причина была главной, и разбор каждый раз упирался в догадку: по
         видимости, торсу и центру понять, повернулся ли ребёнок, нельзя — порог
         сравнивается с этим числом, а его в журнале не было. Физически верное
         значение 0.86, порог 0.45. Около порога — ребёнок правда поворачивался
         корпусом; втрое ниже — врёт форма кадра. */
      if (why === 'profile' && typeof e.ratio === 'number') {
        /* Копятся только крайние значения, а не весь список. Печатается всё
           равно полоса, а массив в отчёте рос бы без предела — и заодно
           пришлось бы решать, сколько раз положить в него склеенное повторами
           событие (`_n`): на min и max это не влияет никак. */
        const r = pauses.profileRatio;
        r.lo = r.lo === null ? e.ratio : Math.min(r.lo, e.ratio);
        r.hi = r.hi === null ? e.ratio : Math.max(r.hi, e.ratio);
      }
      /* То же для `scale`: длина торса и та полоса, с которой её сравнили.
         9 октября восемь таких пауз пришлось разбирать вручную — доставать
         `S0` из `calib.done` и домножать на коэффициент; с полом у потолка так
         уже не выйдет вовсе. Торс копится полосой, границы — крайними: они за
         забег не меняются, но у разных забегов сессии разные. */
      if (why === 'scale' && typeof e.S === 'number') {
        const b = pauses.scaleBand;
        b.lo = b.lo === null ? e.S : Math.min(b.lo, e.S);
        b.hi = b.hi === null ? e.S : Math.max(b.hi, e.S);
        if (typeof e.sLo === 'number') b.sLo = e.sLo;
        if (typeof e.sHi === 'number') b.sHi = e.sHi;
      }
    } else if (open && e?.type === 'resume') {
      closeAt(open, e.t, true);
      open = null;
    } else if (open && (e?.type === 'run.start' || e?.type === 'run.abort')) {
      closeAt(open, e.t, false);
      open = null;
    }
  }
  // Пауза, открытая в конце журнала: из неё так и не вышли.
  if (open) closeAt(open, end, false);
  pauses.unclosed = spans.filter((s) => !s.closed).length;
  pauses.totalS = round(spans.reduce((s, p) => s + (p.end - p.t), 0) / 1000, 1);

  /* Доля считается от пауз ВНУТРИ забега, а не за всю сессию: в сессии живут
     ещё калибровка и прошлые забеги, и деление сессионной суммы на длину
     последнего забега давало долю, которая может перевалить за сто процентов —
     то есть долю неизвестно чего. */
  if (finish) {
    const from = start ? start.t : 0;
    const inRun = spans
      .filter((p) => p.t >= from && p.t <= finish.t)
      .reduce((s, p) => s + (Math.min(p.end, finish.t) - p.t), 0);
    pauses.inRunS = round(inRun / 1000, 1);
    if (run?.durationS) pauses.pctOfRun = round((pauses.inRunS / run.durationS) * 100, 1);
  }

  // ── ошибки ──
  const errs = [...pick(log, 'error'), ...pick(log, 'pose.error')];
  /* Поток считается по ГРУППЕ одинаковых ошибок: от первой отметки до
     последней. Внутри одной записи разброс есть только у склеенных событий, а
     склейка появилась позже самих журналов — все снятые с телефона файлы несут
     поток отдельных записей. Мерить разброс внутри записи означало бы на
     настоящем журнале напечатать «1478 ошибок за 0 с», и именно это он и
     напечатал: 1478 записей с 116.6 с по 249.6 с, то есть 133 с замершего
     экрана, показались мгновением.

     Длительность здесь — не украшение: без неё «упало 1478 раз» неотличимо от
     «падает до сих пор», а это разные дефекты. */
  const groups = new Map();
  for (const e of errs) {
    const key = `${e.where || '?'}: ${e.message || '?'}`;
    const g = groups.get(key) || { n: 0, from: e.t, to: 0 };
    g.n += occurrences(e);
    g.from = Math.min(g.from, e.t);
    g.to = Math.max(g.to, lastT(e));
    groups.set(key, g);
  }
  const errors = {
    total: [...groups.values()].reduce((a, g) => a + g.n, 0),
    spanS: round(max([...groups.values()].map((g) => (g.to - g.from) / 1000)) ?? 0, 1),
    top: [...groups.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 3)
      .map(([message, g]) => ({ message, n: g.n })),
  };

  /* Форма кадра. Расхождение отчёта дорожки с кадром — не мелочь, а тот самый
     дефект, из-за которого 8 октября второй забег был непроходим: одно чужое
     число сжимает горизонталь, и ребёнок, стоящий лицом, читается как
     повёрнутый боком НАВСЕГДА. Поэтому сводка говорит о нём первой строкой, а
     не предлагает догадываться по словам «он не видел меня». */
  for (const a of pick(log, 'cam.aspect')) {
    if (typeof a.said === 'number' && typeof a.aspect === 'number'
      && Math.abs(a.said - a.aspect) > 0.05) {
      /* Кто из двоих врёт — по журналу не видно, и утверждать нельзя: 8
         октября соврали оба по очереди. Утром `getSettings()` отдал портрет
         при ландшафтных кадрах; вечером кадры повернулись по-настоящему (сорвался
         полный экран), а отчёт остался ландшафтным. Поэтому записка называет
         расхождение, а не виноватого. */
      notes.push(`отчёт камеры и кадр расходятся: отчёт ${a.said}, кадр ${a.aspect}`
        + ' — по кадру и считается, но если прав отчёт, горизонталь сжата'
        + ' и присутствие читается как поворот боком');
    }
    if (typeof a.was === 'number' && Math.abs(a.was - a.aspect) > 0.05) {
      notes.push(`форма кадра переучена на ходу: было ${a.was}, стало ${a.aspect}`);
    }
  }

  /* Сырые отсчёты в журнале есть, а в отчёт они не попадают: measurements/
     уезжает в публичный репозиторий, а `samples` и `skeleton` — это записанные
     движения ребёнка. Отчёт говорит только, что они в журнале были. */
  const raw = pick(log, 'samples').length + pick(log, 'skeleton').length;
  if (raw) notes.push(`в журнале есть сырые отсчёты (${raw} записей) — в отчёт они не выносятся`);

  /* Журнал до 7 октября не разделял кольца и очки, и при задетых препятствиях
     поле `stars` показывало ОЧКИ: собранное минус отнятое за удары. Сводка
     обязана сказать это вслух, иначе замер назовёт кольцами то, чем они не
     являются, — а замеры делаются как раз по сводке. При нуле задетых числа
     совпадают по построению, и предупреждать не о чем. */
  if (run && run.score === null && run.hits > 0) {
    notes.push('журнал снят до разделения колец и очков: задел '
      + `${count(run.hits, TIMES)}, значит «колец» выше — это очки, `
      + 'собрано было больше');
  }

  /* ── хранилище ──

     Повод: игрок и рекорды сбрасывались между сеансами. Наш код их не чистит,
     а хранилище, не помеченное постоянным, браузер вправе вытеснить целиком —
     одним origin, вместе с офлайн-кэшем и localStorage. Приложение занимает
     порядка 42 МБ, так что поводов у него достаточно.

     Поэтому в журнал поехали три числа, и читать их надо вместе: вытесняемы ли
     мы, сколько занято и какая это доля квоты. Череда сессий с
     `persisted:false` и большой долей будет значить, что вытеснение и есть
     причина; обратное — что причину надо искать не здесь. */
  const storage = (() => {
    const est = pick(log, 'storage').pop();
    const state = pick(log, 'storage.state').pop();
    const ask = pick(log, 'storage.persist').pop();
    if (!est && !state && !ask) return null;
    return {
      persisted: typeof state?.persisted === 'boolean' ? state.persisted : null,
      granted: typeof ask?.granted === 'boolean' ? ask.granted : null,
      usageMb: est?.usageMb ?? null,
      quotaMb: est?.quotaMb ?? null,
      pct: est?.pct ?? null,
    };
  })();

  return {
    id: session?.id ?? null,
    startedAt: session?.startedAt ?? null,
    ua: session?.ua ?? null,
    events: log.length,
    spanS: round(end / 1000, 1),
    finished,
    pose,
    perf,
    panSpan,
    storage,
    /* Зоны, которые забег успел показать, и большие кольца, которые ребёнок
       успел собрать. Оба — проверка замысла, а не украшение: зоны обязаны
       смениться все (границы по долям забега, см. zoneAt), а большие кольца
       обязаны встречаться и не превращаться в большинство. */
    zones: pick(log, 'zone').map((e) => e.zone),
    bigStars: pick(log, 'star').filter((e) => (e.worth ?? 1) > 1)
      .reduce((n, e) => n + occurrences(e), 0),
    run,
    runs,
    pauses,
    /* Реакция — НЕ внутри `run`, хотя считается по забегу. Забег без финиша
       брошен, и `run` у него null, — а время ответа у брошенного забега есть
       и оно‑то как раз интереснее всего: именно по нему видно, успевал ребёнок
       или нет, прежде чем бросил. */
    reaction,
    errors,
    notes,
  };
}

/** Разбор всего файла выгрузки: сессий в нём до двадцати, и нужная — не первая. */
export function reportAll(dump) {
  const sessions = Array.isArray(dump?.sessions) ? dump.sessions : [];
  return sessions.map(report);
}

// ───────────────────────────── печать ─────────────────────────────

function мс(v) { return v === null ? '—' : `${v} мс`; }
function чис(v) { return v === null ? '—' : String(v); }

/** Человекочитаемая сводка одной сессии. */
export function format(rep) {
  const L = [];
  const когда = (rep.startedAt || '').replace('T', ' ').slice(0, 16);
  L.push(`сессия ${когда || rep.id}   журнал ${rep.spanS} с, ${rep.events} записей`);

  L.push(`  делегат ${rep.pose.delegate ?? '—'} (${rep.pose.pipeline ?? '—'})`
    + `   прогрев p50 ${мс(rep.pose.warmupP50)}   init ${мс(rep.pose.initMs)}`);

  /* Строка про хранилище печатается только когда поля есть: у журналов до этой
     правки их нет, и «вытесняемое / 0 МБ» читалось бы как замеренный факт.

     Слово выбрано осторожно: `persisted:false` значит не «вытеснено», а
     «вправе вытеснить». Путать это нельзя — ровно на такой подмене разбор
     однажды уже соврал, печатая просьбу «экран не гаснет» вместо того, что с
     экраном случилось. */
  /* Зоны печатаются цепочкой, в том порядке, в котором их видел ребёнок.
     Молчит, если событий нет: у журналов до зон их не было. */
  if (rep.zones?.length) {
    L.push(`  зоны: ${rep.zones.join(' → ')}`);
  }

  if (rep.storage) {
    const st = rep.storage;
    const режим = st.persisted === true ? 'постоянное'
      : st.persisted === false ? 'ВЫТЕСНЯЕМОЕ (рекорды браузер вправе удалить)'
        : 'неизвестно';
    const занято = st.usageMb == null ? ''
      : `, занято ${st.usageMb} МБ` + (st.quotaMb ? ` из ${st.quotaMb}` : '')
        + (st.pct == null ? '' : ` (${st.pct}%)`);
    const просьба = st.granted === null ? ''
      : st.granted ? ', просьбу удовлетворили' : ', в просьбе отказали';
    L.push(`  хранилище: ${режим}${занято}${просьба}`);
  }

  if (rep.perf.windows) {
    L.push(`  позы ${чис(rep.perf.hz.med)} Гц (цель 20)   кадры ${чис(rep.perf.fps.med)} fps`
      + `   потеряно кадров ${rep.perf.drop}`);
    // Медиана окон и худшее окно — разные числа, и подписаны они по-разному
    // намеренно: p50 по всему забегу из оконных квантилей не получается.
    L.push(`  инференс: медиана окон ${мс(rep.perf.infer.med)}, худшее окно по p95 `
      + `${мс(rep.perf.infer.worst)}   (окон ${rep.perf.windows})`);
    L.push(`  отрисовка: медиана окон ${мс(rep.perf.draw.med)}, худшее `
      + `${мс(rep.perf.draw.worst)}`);
    L.push(`  поза видна ${чис(rep.perf.ok)} доли отсчётов, видимость ${чис(rep.perf.vis)}, `
      + `торс S ${чис(rep.perf.S)}`);
  }

  // Единицы подписаны не для красоты: `u` в health — доли игрового поля, а в
  // gesture — длины торса, и весь разбор строится на сравнении этих чисел.
  L.push(`  ширина поля panSpan ${чис(rep.panSpan)} (u в health — доли поля)`);

  if (rep.run) {
    const o = rep.run.obstacles;
    const looks = Object.entries(o.byLook || {});
    /* Нет `starsTotal` — журнал снят со сборки, которая его не писала, и доли
       не существует. Печатать «null%» значит предлагать принять это за число. */
    L.push(`  забег ${rep.run.durationS} с: ${rep.run.stars} колец`
      + (rep.run.ringPct === null
        ? '  (сколько было расставлено — не записано)'
        : ` из ${rep.run.starsTotal} (${rep.run.ringPct}%)`)
      // Очки печатаются только когда они отличаются: равные числа означают
      // забег без задетых, и второе число там ничего не добавляет.
      + (rep.run.score !== null && rep.run.score !== rep.run.stars
        ? `, ${rep.run.score} очков на экране` : ''));
    /* Большие кольца — рядом с кольцами, а не с препятствиями: это про сбор.
       Молчит при нуле: у журналов до больших колец их не было, и «0» читался бы
       как «ни одного не собрал», а не «их не было в игре». */
    if (rep.bigStars) {
      L.push(`          из них больших: ${rep.bigStars}`);
    }

    // Та же осторожность, что и с долей колец: доли без знаменателя нет.
    if (o.total) {
      L.push(`  препятствия: ${o.total} всего — чисто ${o.clear}, прощено ${o.grace}, `
        + `задето ${o.hit}   не задето ${rep.run.cleanPct}%`);
      /* Разбивка по внешности. Печатается только когда поле в журнале есть:
         перекраски появились позже журналов, и «неизвестно/0» выглядело бы как
         замеренный ноль. Сравнивать надо две внешности ОДНОГО действия: если у
         одной задето заметно больше, значит силуэт читается хуже, и чинить надо
         картинку, а не телеграф. */
      if (looks.length) {
        L.push('          по внешности: ' + looks
          .map(([k, b]) => `${k} ${b.total - b.hit}/${b.total}`)
          .join(' · '));
      }
    } else {
      L.push(`  препятствий в журнале нет (задето по run.finish: ${rep.run.hits})`);
    }
  }

  /* Разбивка по забегам. Печатается, когда она что-то добавляет: либо забегов
     больше одного, либо у забега записана политика экрана. У журналов до замера
     нет ни того, ни другого, и сводка о нём молчит — печатать «экран: null»
     значило бы предлагать принять отсутствие записи за наблюдение. */
  const политики = rep.runs.filter((r) => r.screenRun).length;
  if (rep.runs.length > 1 || политики) {
    L.push(`  забегов в сессии: ${rep.runs.length}`);
    rep.runs.forEach((r, i) => {
      const экран = r.screenRun
        ? `, просили ${r.screenRun === 'sleep' ? 'гаснуть' : 'не гаснуть'}`
        : '';
      // Печатается только когда блокировку действительно теряли: ноль ни о чём
      // не говорит, а строка о нём отвлекала бы от того, что говорит.
      const потери = r.wakeLost || r.wakeRegained
        ? `, блокировка: потеряна ${r.wakeLost}, взята заново ${r.wakeRegained}`
        : '';
      L.push(`    ${i + 1}) ${чис(r.durationS)} с${экран}${потери}`
        + `  —  кадры ${чис(r.fps)} fps, позы ${чис(r.hz)} Гц,`
        + ` инференс ${мс(r.infer)}  (окон ${r.windows})`);
    });
  }

  /* Реакция. Печатается только когда есть что печатать: «реакция —» читалось бы
     как замеренный прочерк, а это просто журнал со сборки, не писавшей телеграф
     в лог. Число случаев идёт рядом с медианой намеренно: 26 препятствий — не
     статистика, и решать по такой медиане судьбу `signalS` можно только зная,
     из скольких она посчитана. */
  if (rep.reaction && rep.reaction.n) {
    const t = rep.reaction;
    L.push(`  реакция (${t.n} препятствий): думал ${t.thinkMed} с, худший ${t.thinkMax} с`
      + `; запас до препятствия ${t.leadMed} с, минимум ${t.leadMin} с`
      + (t.duckLeadMed === null ? '' : `; присед за ${t.duckLeadMed} с до`));
  }

  if (rep.pauses.episodes) {
    const why = Object.entries(rep.pauses.byWhy).map(([k, v]) => `${k} ${v}`).join(' · ');
    /* Сессионная сумма и время в забеге — разные числа, и когда они разные,
       печатаются оба: иначе доля выглядит посчитанной не от того, от чего. */
  L.push(`  паузы: ${rep.pauses.episodes} эпизодов, ${rep.pauses.totalS} с за сессию`
      + (rep.pauses.pctOfRun === null
        ? ''
        : `; в забеге ${rep.pauses.inRunS} с (${rep.pauses.pctOfRun}%)`));
    L.push(`          ${why}`);
    /* Отношение плеч к торсу у пауз `profile` — то число, которым судили.
       Печатается только когда оно в журнале есть: у прежних журналов его нет
       вовсе, и молчание здесь честнее, чем «—». Физически верное значение
       0.86, порог 0.45. Около порога — ребёнок правда поворачивался корпусом;
       втрое ниже — значит врёт форма кадра, и чинить надо не порог. */
    const rr = rep.pauses.profileRatio;
    if (rr.lo !== null) {
      L.push(`          плечи к торсу у «profile»: ${чис(rr.lo)}–${чис(rr.hi)}`
        + ' при пороге 0.45 и физически верных 0.86');
    }
    /* Торс и полоса присутствия у пауз «scale». Без полосы паузу не разобрать:
       потолок относительный (S0 × scaleRelMax, но не ниже scaleCeilMin), и из
       одной длины торса не видно, близко игрок подошёл или калибровка намерила
       его короче, чем он есть. Ровно так и вышло 9 октября. */
    const sb = rep.pauses.scaleBand;
    if (sb.lo !== null) {
      const полоса = sb.sLo !== null && sb.sHi !== null
        ? ` при полосе ${чис(sb.sLo)}–${чис(sb.sHi)}`
        : ' (полосы в журнале нет: сборка до sLo/sHi)';
      L.push(`          торс у «scale»: ${чис(sb.lo)}–${чис(sb.hi)}${полоса}`);
    }
    /* Незакрытая пауза считана до конца журнала, и это НЕ время, проведённое
       в паузе посреди игры: сеанс просто кончился на ней. Без этой оговорки
       доля пауз выглядит вдвое хуже, чем была на самом деле. */
    if (rep.pauses.unclosed) {
      L.push(`          из них не закрыто: ${rep.pauses.unclosed} — считаны до конца`
        + ' журнала, то есть сеанс кончился на паузе');
    }
  }

  if (rep.errors.total) {
    L.push(`  ошибки: ${rep.errors.total} за ${rep.errors.spanS} с`);
    for (const e of rep.errors.top) L.push(`          ${e.n} × ${e.message}`);
  }

  for (const n of rep.notes) L.push(`  ! ${n}`);
  return L.join('\n');
}

/** Готовый блок для measurements/: то же самое, но разметкой и под коммит. */
export function markdown(rep) {
  const когда = (rep.startedAt || '').replace('T', ' ').slice(0, 16);
  const L = [`# Замер ${когда || rep.id}`, ''];
  L.push('Снято разбором журнала: `node tools/log-report.mjs <файл>`.');
  L.push('Сам журнал в репозиторий не уезжает — это запись о ребёнке.', '');
  L.push('```');
  L.push(format(rep));
  L.push('```', '');
  L.push('## Что из этого следует', '');
  L.push('- <какие числа в `js/config.js` правятся и почему>');
  return L.join('\n');
}

// ───────────────────────────── запуск ─────────────────────────────

const прямойЗапуск = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (прямойЗапуск) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Нужен файл журнала:\n  node tools/log-report.mjs logs/run-game-log-*.json');
    process.exit(1);
  }
  let printed = 0;
  for (const file of files) {
    let dump;
    try {
      dump = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`${file}: не прочитался — ${e.message}`);
      process.exit(1);
    }
    const reports = reportAll(dump);
    console.log(`\n${file}   сессий ${reports.length}`
      + (dump.exportedAt ? `, выгружено ${dump.exportedAt.slice(0, 16).replace('T', ' ')}` : ''));
    /* Сессии печатаются ВСЕ. Интересная — не обязательно первая: у ребёнка
       первый сеанс упал на калибровке, а разбирать надо было оба. */
    for (const rep of reports) {
      console.log('\n' + format(rep));
      printed++;
    }
  }
  console.log(`\nразобрано сессий: ${printed}`);
  console.log('Блок для measurements/ — markdown() из этого же модуля.');
}
