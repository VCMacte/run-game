// Забег: дирижёр. Имя файла историческое — переименованию не подлежит.
//
// Связывает источник поз, математику сигналов и панораму, ведёт стадии, паузу
// и отсчёт. Сам ничего не вычисляет — за каждым числом здесь стоит модуль,
// который проверяется без браузера.
//
// Стадии: установка штатива → калибровка → забег → результат. Внутри забега
// живут телеграф, приговор препятствия, сбор колец, смена зоны и финиш.
//
// Здесь стояло «препятствий и телеграфа пока нет: ребёнок обнаруживает, что
// вид едет за его телом». Это была правда третьего этапа и перестала ею быть,
// когда появился `stepObstacles`; шапка пережила свой проект на полтора
// десятка коммитов. Устаревший разбор дороже дефекта — он врёт уверенно.
//
// Разбор: docs/calibration.md, docs/difficulty.md, docs/menu-and-navigation.md, docs/presence-and-pause.md, docs/rings.md, docs/view-and-zones.md

import { SIGNALS as S, VIEW, POSE, OBSTACLES as O, FINISH as FIN } from './config.js';
import { makeTracker, makeFollower, geometry } from './signals.js';
import { createView, makeStars, makeDecor, canReach } from './view.js';
import { MOTION, zonesOf, SKY_FILES, zoneAt } from './theme.js';
import {
  makeCalibration, load as loadCalibration, save as saveCalibration, isStale, panSpanOf,
  forReuse,
} from './calibrate.js';
import { framing, frameAspect } from './camera.js';
import { drawSkeleton, updateField } from './preview.js';
import { makeLevel, isSafe, telegraph, telegraphDebt } from './level.js';
import { tuneFor, clampStep } from './difficulty.js';
import { players } from './players.js';
import * as audio from './audio.js';
import { settings, runDurationS, poseDelegate } from './settings.js';
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
  let grace = 0;
  return {
    get collected() { return collected; },
    get score() { return score; },
    get hits() { return hits; },
    /* Прошедшие ТОЛЬКО благодаря окну прощения — отдельное, четвёртое число.

       Для ребёнка такое препятствие пройдено: очки целы, вспышки нет. Для
       тихой адаптации это единственный честный датчик того, что запаса не
       осталось: ушёл он уже после прихода, в те 350 мс, которые ему прощают.

       Числа «за 105 препятствий прощение не израсходовано ни разу» у проекта
       НЕТ и никогда не было: то, что печаталось как «прощено», считало удары,
       поглощённые неуязвимостью от предыдущего удара, а при `invulnMs` 1500
       против `minGapS` 5500 такого случиться не может вовсе. Настоящий расход
       окна прощения меряется с 11 октября, и первый журнал с ним покажет, был
       ли он нулевым на самом деле. */
    get grace() { return grace; },
    /* Вес уходит в ОЧКИ, а собранное считается штуками.

       Это не мелочь: `collected` идёт в «X из Y колец» на экране результата и
       в рекорд, а знаменателем там `stars.length` — тоже штуки. Прибавь вес к
       собранному, и строка начнёт говорить «102 из 100». Ровно этот класс
       ошибки — один счётчик на два смысла — здесь уже случался. */
    star(worth = 1) { collected++; score += worth; },
    hit() {
      hits++;
      // Ниже нуля счётчик в HUD опускаться не должен. Собранное зажимать
      // нечем и незачем — оно только растёт.
      score = Math.max(0, score - starsLost);
    },
    // Имя `forgive`, а не `grace`: рядом стоит геттер того же счёта, и
    // объект с двумя одинаковыми именами молча потерял бы одно из них.
    forgive() { grace++; },
    reset() { collected = 0; score = 0; hits = 0; grace = 0; },
  };
}

/* `world` и `prizes` приходят снаружи, из js/app.js: какой мир открыт и какие
   призы взяты — дело копилки и js/awards.js, а дирижёр забега про хранилище не
   знает вовсе. Умолчания здесь не на случай ошибки, а для прогона из node:
   первый мир открыт всегда, призов у нового игрока нет. */
export function createTraining({ canvas, video, skeleton, field, fieldMark, onHud,
                                 world = 'hills', level = 0, prizes = {}, step = 0 }) {
  /* Уровень сложности приходит СНАРУЖИ, как мир и призы, и читается здесь
     один раз — до того, как создан вид. Так пришлось сделать, когда скорость
     стала различаться по уровням: вид получает её при создании, а создаётся
     он раньше первого забега. Прежде `step` читался из профиля внутри, в
     момент входа в забег; теперь выбор живёт в меню, и хранилище дирижёру
     забега по-прежнему не нужно. */
  const УРОВЕНЬ = clampStep(step);
  const ЧИСЛА = tuneFor(УРОВЕНЬ);
  const РЕЙС = ЧИСЛА.speed;
  /* Фон неба растром. Грузится без ожидания: пока картинки нет, `drawSky`
     рисует плоские полосы и силуэт холмов, и игра работает полностью. Так и
     задумано — арт собирается отдельным прогоном Easy Diffusion, и забег не
     должен от него зависеть. Ошибка загрузки тоже ничего не ломает: у
     незагруженной картинки `width` равен нулю, а именно это и проверяется.

     Путь абсолютный, от модуля: относительный разрешался бы от того, кто
     вызывает, и на телефоне выяснилось бы, что он указывает не туда. */
  /* Растры неба — по одному на зону.

     Заказчик: «смена цветового оформления во время забега работает хорошо, но
     небо и дальний план остаются без изменений». Так и было: растр один, и
     кладётся он во весь кадр, то есть из-под него цветов зоны не видно вовсе.

     Грузятся все три сразу и молча: `onerror` не обрабатывается нарочно —
     неподгрузившийся растр просто не станет `complete`, и `drawSky` уйдёт
     запасным путём, который красится цветами своей зоны. Игра не имеет права
     зависеть от арта, он собирается отдельным прогоном. */
  const backdrops = {};
  for (const [zone, file] of Object.entries(SKY_FILES)) {
    const im = new Image();
    im.src = new URL(`../assets/${file}`, import.meta.url).href;
    backdrops[zone] = im;
  }

  const view = createView(canvas, { backdrops, speed: РЕЙС });
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
  // Последняя зона — только чтобы не писать в журнал одно и то же каждый кадр.
  let lastZone = null;
  let durationS = 240;
  let result = null;
  /* Имена `step` и `tune` историческими остаются в ЖУРНАЛЕ и в записи
     рекорда — здесь же числа зовутся `УРОВЕНЬ` и `ЧИСЛА`, потому что
     приходят параметром и заданы выше. */
  /* Сколько раз забег уходил в паузу. Нужен ступени: усложнять по забегу с
     паузами нельзя — 7 октября единственное задетое препятствие за всю
     историю объясняется ложной паузой, а 9 октября восемь пауз сделали забег
     несуществующим. Считается ЗАБЕГ, а не сессия, поэтому сброс там же, где
     tally.reset(). */
  let pauses = 0;
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
  const health = { frames: 0, poses: 0, ok: 0, infer: [], draw: [], gaps: [],
    dropped: 0, since: 0, vis: 0, S: 0 };

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
  /* Параметр адреса сильнее настройки — он осознанный и на один раз, — но
     вычисляется один раз: адрес посреди забега не меняется, а `flag()`
     разбирает строку запроса на каждом вызове. Настройка читается живо: она
     лежит в памяти, и включить запись можно посреди забега, не перезагружаясь.

     Прерывистая запись — законный случай, и читатель о нём знает: частота в
     `tools/replay.mjs` считается по медиане промежутка, а не по размаху,
     иначе дыра посреди потока занизила бы её молча. */
  const recordForced = flag('record') !== null;
  const recording = () => recordForced || settings.get('record') === 'on';
  let batch = [];

  /* Кольцо сырых строк. Пишется ВСЕГДА, и в этом вся мысль.

     Сплошная запись стоит мегабайт в минуту и поэтому требует, чтобы о ней
     подумали заранее: включи, пробеги, не забудь выключить. Ритуал из
     четырёх шагов не исполняется — ровно так `?record=1` и прожил тринадцать
     журналов без единого срабатывания. А интересна запись не вся: интересны
     две секунды ПЕРЕД тем, как что-то случилось.

     Поэтому строки копятся в кольце даром, а в журнал уходят только вокруг
     происшествия — там же, где уже уходит `samples` с выводами трекера.
     Включать ничего не надо, потолок журнала цел, а разбор получает ровно те
     мгновения, из-за которых его и заводят. */
  const rawRing = [];
  let rawBursts = 0;
  let lastRawT = 0;

  /** Строка для журнала: отметка времени и 132 числа, округлённые до тысячных. */
  function rawRow(lm, now) {
    const row = new Array(133);
    row[0] = Math.round(now);
    for (let i = 0; i < 132; i++) row[i + 1] = Math.round(lm[i] * 1000) / 1000;
    return row;
  }

  function recordSkeleton(sample, now) {
    if (!sample.lm) return;
    const row = rawRow(sample.lm, now);

    rawRing.push(row);
    if (rawRing.length > S.rawRing) rawRing.shift();

    if (!recording()) return;
    batch.push(row);
    if (batch.length >= 20) {
      log.event('skeleton', { n: batch.length, rows: batch });
      batch = [];
    }
  }

  /**
   * Сбросить в журнал последние две секунды сырых строк.
   *
   * Зовётся там, где случилось то, что потом будут разбирать: пауза и удар.
   * При сплошной записи молчит — те же строки уже уходят потоком, и второй
   * экземпляр только раздувал бы журнал.
   *
   * `lastRawT` не даёт выслать одну строку дважды: у двух происшествий
   * подряд общее прошлое, и без него перекрытие уехало бы в журнал дважды, а
   * в разборе выглядело бы удвоенной частотой.
   */
  function flushRaw(why, now) {
    if (recording() || rawBursts >= S.rawBursts) return;
    const rows = rawRing.filter((r) => r[0] > lastRawT && now - r[0] <= 2000);
    if (!rows.length) return;
    rawBursts++;
    lastRawT = rows[rows.length - 1][0];
    log.event('skeleton', { n: rows.length, why, rows });
    /* Исчерпанный потолок обязан быть виден. Молча прекратившаяся запись
       неотличима от «больше ничего не случилось». */
    if (rawBursts === S.rawBursts) log.event('skeleton.cap', { bursts: rawBursts });
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
      /* Длина забега — из `settings.js`, одной функцией на всех. Лесенка
         перебивок (параметр адреса → отладочный режим → настройка) живёт там,
         потому что читателей у неё два: забег и подпись под кнопкой «Играть».
         Вторая копия означала бы меню, обещающее пять минут над
         тридцатисекундным забегом. */
      durationS = runDurationS();
      /* Препятствия ПЕРВЫМИ: кольца расставляются уже зная о них.

         Раньше оба расписания строились независимо, и в журнале первого
         полного забега одиннадцать колец оказались ближе 0.35 с к
         препятствию. Поменять эти две строки местами — значит вернуть кольца,
         которые нельзя собрать, не ударившись. */
      /* Уровень и его числа взяты при создании дирижёра и до финиша не
         меняются. Расписание строится один раз на забег, и край препятствия
         уезжает в само препятствие — поменять уровень посередине значило бы
         развести картинку с приговором на тех препятствиях, что уже
         расставлены. */
      obstacles = makeLevel({
        durationS, crouch: settings.get('crouch'), tune: ЧИСЛА, world,
      });
      /* `tune` обязателен: без него кольца строились бы умолчаниями `VIEW`,
         то есть ступень 0 получала бы ряд ступеней 1…4 — с кольцом в окне
         уклонения и переходом впритык. Ровно то, что правка и убирает. */
      stars = makeStars({ durationS, obstacles, tune: ЧИСЛА, speed: РЕЙС });
      decor = makeDecor({ durationS, world, speed: РЕЙС });
      travel = 0;
      elapsed = 0;
      tally.reset();
      pauses = 0;
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
        /* На чём ПРОСИЛИ считать позу. Рядом со `screenRun` и по той же
           причине: два забега одной сессии иначе неразличимы, а замер ровно в
           том и состоит, чтобы сравнить их внутри одной. Что получилось —
           в `pose.ready`; просьба без исхода неотличима от «получилось». */
        delegate: poseDelegate(),
        /* Ступень И её числа. Номер без чисел бесполезен: таблицу ступеней
           однажды перепишут, и прошлый журнал перестанет читаться — ровно та
           же причина, по которой рядом с `u` в health едет `panSpan`. */
        step: УРОВЕНЬ, tune: ЧИСЛА,
        /* Мир и уровень кубка. Без них два забега одной сессии в разных мирах
           в журнале неразличимы, и ни один замер про миры снять нельзя — та же
           причина, по которой рядом едет screenRun. */
        world, level,
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
    /* Зовётся ВСЕГДА, а не под условием: кольцо сырых строк копится даром и
       нужно именно в тот момент, когда о записи никто заранее не подумал.
       Сплошную запись решает сам recordSkeleton. */
    recordSkeleton(sample, now);

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
    if (stage === 'free') pauses++;
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
    /* И те же две секунды СЫРЫМИ строками — их можно прогнать заново через
       нынешний код (tools/replay.mjs), а выводы ниже нельзя: по ним видно,
       что игра решила, но не что она решила бы после правки порога. */
    flushRaw('pause', rec.t);

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

  /* Вернуть забегу телеграф, съеденный паузой.

     Зовётся из начала отсчёта, а не из возврата, и это содержательно: отмотка
     двигает МИР назад (время забега и путь связаны одним множителем), и делать
     это надо, пока мир стоит под надписью отсчёта. На возврате ребёнок увидел
     бы скачок коридора назад.

     Отметки телеграфа этого препятствия сбрасываются: `announced` и `calledAt`
     — флаги «уже сыграно», и без сброса отмотанное время прошло бы в тишине,
     то есть вернуло бы секунды, но не сам телеграф. Долг считает `level.js`
     той же функцией, что проверяется тестами. */
  function giveBackTelegraph() {
    const долг = telegraphDebt(obstacles, elapsed);
    if (!(долг > 0)) return;
    elapsed -= долг;
    travel -= долг * РЕЙС;
    const ob = obstacles.find((o) => !o.passed && o.at > elapsed);
    if (ob) { ob.announced = false; ob.calledAt = 0; }
    log.event('rewind', {
      s: round(долг, 2),
      at: ob ? round(ob.at, 1) : null,
      kind: ob?.kind ?? null,
    });
  }

  function beginCountdown(now) {
    if (run !== RUN.paused) return;
    run = RUN.countdown;
    countdownUntil = now + S.resumeMs + S.countdown * 1000;
    giveBackTelegraph();
    log.event('countdown', { n: S.countdown });
    hud();
  }

  // ───────────────────────── кадры ─────────────────────────

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    /* Ровность хода копится СЫРЫМ интервалом, без зажима 0.05 выше. Зажим
       защищает забег от прыжка вперёд после замершей страницы, но для меры
       плавности он же и слепота: провал на 120 мс — ровно то, что ребёнок
       чувствует, — прочитался бы как 50. Поэтому мера берётся до зажима. */
    if (lastFrame) health.gaps.push(now - lastFrame);
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
        travel += РЕЙС * dt;
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
        if (z > 0 && z < VIEW.starTakeS * РЕЙС && canReach(s.x, u)) {
          s.taken = true;
          s.takenAtS = elapsed;
          tally.star(s.worth ?? 1);
          log.event('star', { side: Math.sign(s.x), u: round(u), worth: s.worth ?? 1 });
          // Три ноты вместо двух: мотивы различаются числом нот, см. audio.js.
          audio.play(s.worth > 1 ? 'starBig' : 'star', prizes);
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
    /* Зона кадра. Решает её дирижёр, а не вид: вид не знает ни длины забега, ни
       стадии. Считается каждый кадр и ничего не стоит — `zoneAt` это деление и
       округление, — зато состояния здесь нет вовсе, как у всех анимаций
       проекта: при просадках кадра накопительное расписание разошлось бы с
       картинкой.

       На стадиях ДО забега зона всегда первая: установка штатива и калибровка
       идут в понятных цветах, а не в тех, до которых ребёнок ещё не добежал. А
       на стадии результата держится последняя: кадр продолжает рисоваться за
       текстом результата, у `#runOverlay` своего фона нет, и возврат к первой
       зоне выглядел бы как прыжок из ночи обратно в утро. Попутно это снимало
       лишнюю запись в журнал, из-за которой цепочка зон кончалась возвратом в
       `greenHill` — а она описана как «в том порядке, в котором их видел
       ребёнок». */
    const zone = stage === 'free' || stage === 'result'
      ? zoneAt(elapsed, durationS, world)
      : zonesOf(world)[0];
    if (zone !== lastZone) {
      lastZone = zone;
      log.event('zone', { zone, at: round(elapsed, 1) });
    }

    view.render({
      decor,
      speed: lastSpeed,
      u, v, travel, stars, obstacles, elapsed, zone,
      /* Набор призов фиксирован на старте забега и едет ПАРАМЕТРОМ: вид про
         хранилище не знает, поэтому его и можно считать из node, а
         tools/replay.mjs — подать любой набор. */
      prizes,
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
    /* Знает ли игра, где ребёнок по горизонтали. В приседе не знает — и тогда
       боковой приговор не выносится вовсе (разбор — в isSafe). */
    const lateralKnown = !(tracker?.lateralHeld ?? false);
    lastSafe = true;

    for (const ob of obstacles) {
      if (ob.passed) continue;
      const dt = ob.at - elapsed;
      if (dt > O.signalS) break; // список по времени — дальше смотреть незачем

      const safe = isSafe(ob, { camX, crouching, lateralKnown });
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
        /* Ушёл ли ребёнок ВОВРЕМЯ или успел уже в окне прощения. Для него
           разницы нет — проход и есть проход, — а для ступени сложности это
           единственный честный датчик того, что запаса не осталось.

           Считалось это раньше не здесь, и считалось неправильно: `forgive()`
           стоял в ветке неуязвимости, то есть срабатывал, только если удар
           поглотила неуязвимость от ПРЕДЫДУЩЕГО удара. А `invulnMs` 1500 мс
           против `minGapS` 5500 — два препятствия в это окно не помещаются
           никогда, значит ветка была недостижима по построению. Отсюда и
           «прощение не израсходовано ни разу» в замерах: ноль был не
           наблюдением, а свойством кода. Поймано ревью. */
        const вОкне = ob.verdictAt !== null;
        if (вОкне) tally.forgive();
        audio.play('clear');
        log.event('obstacle', {
          kind: ob.kind, look: ob.look ?? null, side: ob.side, result: 'clear',
          camX: round(camX),
          // Поле есть только когда окном воспользовались: иначе каждая
          // запись несла бы `forgiven: false`, а журнал и так самый большой
          // расход места в проекте.
          ...(вОкне ? { forgiven: true } : {}),
          /* Проход, доставшийся незнанием, обязан быть виден в журнале. Без
             поля он неотличим от заработанного, и «140 препятствий чисто»
             однажды будет значить «часть из них ребёнок пролежал». По той же
             причине поле только у таких записей: журнал и так дорог. */
          ...(ob.kind === 'side' && !lateralKnown ? { lateralUnknown: true } : {}),
        });
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
        /* Сырые строки перед задетым препятствием. Это второй случай, ради
           которого кольцо и заведено: открытый вопрос №1 — «к моменту прихода
           препятствия ничто не говорит стой где стоишь» — виден как раз
           здесь, в том, где было тело за две секунды до приговора.

           Прощённый удар (grace) тоже пишется: он отличается от задетого
           только неуязвимостью от прошлого, а телом ребёнка — ничем. */
        flushRaw('hit', now);
      }
    }
  }

  /* Итог забега для ступени сложности.

     Считается и на финише, и на брошенном забеге: вверх ступень идёт только
     по доведённому до конца, а ВНИЗ — по любому. Асимметрия намеренная, и
     разбор её в js/difficulty.js: данных «ребёнку трудно» у проекта нет
     вовсе, а цена ошибки несимметрична.

     `faced` — препятствия, ДОШЕДШИЕ до приговора, а не все расставленные: у
     брошенного забега их сильно меньше, и считать по расписанию значило бы
     судить о том, чего ребёнок не видел. */
  function outcomeOf(finished) {
    const faced = obstacles.filter((o) => o.passed).length;
    /* Знаменатель у брошенного забега — кольца, которые ребёнок УСПЕЛ
       увидеть, а не всё расписание. Иначе забег, брошенный на середине,
       пишет в журнал «колец 45%» при всех собранных: на решение это не
       влияет (вверх пускает только доведённый до конца), но число печатается
       как оценка игры, и читать его так было бы неверно. */
    const total = finished ? stars.length : stars.filter((s) => s.at <= elapsed).length;
    return {
      finished,
      faced,
      late: tally.hits + tally.grace,
      pauses,
      ringPct: total ? Math.round((tally.collected / total) * 100) : 0,
    };
  }

  /* Итог забега в журнал — один раз, здесь.

     СТУПЕНЬ БОЛЬШЕ НЕ ДВИГАЕТСЯ САМА, и это отмена прежнего решения. Правило
     перехода («вверх только по безупречному забегу, вниз по любому») сняли
     18 октября по требованию заказчика: «менять сложность автоматически не
     надо, для смены сложности нужна кнопка выбора, как это сделано с выбором
     мира». Опровергнут не сам механизм — он отработал ровно как описан, —
     а его посылка: журнал того дня показал первое в истории проекта
     повышение 0 → 1 по безупречному забегу, и тот же журнал напечатал
     предупреждение о запасе до препятствия в 0.07 с. Заказчик про те же два
     забега сказал иначе: первый был ребёнку трудным, второй лёгким.
     Трудность словом и трудность числом разошлись, и мерить её числом в этом
     проекте нечем.

     Событие пишется ВСЕГДА и с теми же полями: отсутствие события неотличимо
     от «код не выполнился», а числа забега — единственное, по чему взрослый
     выберет кнопку. Слово `why` теперь `chosen` («уровень выбран рукой») или
     `fake` у синтетики; разбор журнала продолжает понимать и старые
     `easy`/`hard`/`held`, иначе снятые журналы перестали бы читаться — то
     есть сравнимость потерялась бы ровно там, где она и доказывает
     необходимость правки.

     Вид источника спрашивается у НЕГО САМОГО (`source.kind`), а не
     сравнением со строкой: в этом модуле `source` — объект, который вернул
     pose.start(). */
  function logRun(finished) {
    const outcome = outcomeOf(finished);
    const фейк = source?.kind === 'fake';
    log.event('difficulty', {
      from: УРОВЕНЬ, to: УРОВЕНЬ, why: фейк ? 'fake' : 'chosen',
      finished, faced: outcome.faced, late: outcome.late,
      hits: tally.hits, grace: tally.grace,
      pauses, ringPct: outcome.ringPct,
    });
    return УРОВЕНЬ;
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
    /* Итог забега пишется ПОСЛЕ записи финиша: в журнале сначала цифры,
       потом разбор по ним, и читается это сверху вниз. Номер уровня уезжает
       и в результат — оттуда его берёт запись рекорда. */
    result.step = logRun(true);
    audio.play('finish', prizes);
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
    const gaps = health.gaps;
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
      /* Ровность хода: насколько затянулся худший кадр окна. Медианы интервала
         рядом НЕТ намеренно — она и есть 1000/fps, то есть вторая копия
         соседнего поля, а две копии одного числа в этом проекте расходятся. */
      gap95: gaps.length ? Math.round(quantile(gaps, 0.95)) : 0,
      u: round(last.u),
      v: round(last.v),
      /* Чем поделено `u`. С этим полем журнал объясняет сам себя: здесь `u` в
         долях ИГРОВОГО ПОЛЯ, а в событии `gesture` — в длинах торса. Перепутать
         их легко, а разбор забега строится ровно на сравнении этих чисел между
         ребёнком и взрослым. Нет поля — журнал от сборки до нормировки поля. */
      panSpan: round(panSpanOf(calibration)),
    });
    health.frames = 0; health.poses = 0; health.ok = 0; health.dropped = 0;
    health.vis = 0; health.S = 0; health.infer = []; health.draw = []; health.gaps = [];
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
      /* Калибровка сбрасывается: другая камера — другая сцена, и прежние
         пороги описывают уже не её. Этим переключение камеры и отличается от
         перезапуска ниже. */
      calibration = null;
      await this.restartPose();
      return next;
    },

    /**
     * Перезапустить распознавание, ничего больше не меняя.
     *
     * Нужно затем, что делегат задаётся при СОЗДАНИИ распознавателя, и
     * поменять его у работающего нельзя — ровно как facingMode у открытой
     * дорожки. А без перезапуска замер «процессор против видеоядра» требовал
     * бы перезагрузки страницы, то есть нового сеанса журнала: разброс
     * устройства ±8 fps живёт как раз между сеансами и съел бы весь эффект.
     * Это та же причина, по которой `screenRun` переключается на ходу.
     *
     * Калибровку здесь НЕ сбрасываем: сцена та же, пороги по-прежнему про
     * неё. Сбросить её значило бы заставить ребёнка встать в рамку заново
     * посреди замера — и потерять половину сравнимости.
     */
    async restartPose() {
      log.event('pose.restart', { want: poseDelegate() });
      await pose.stop();
      source = await pose.start({ source: 'camera', hz: POSE.hz, onSample });
      if (video && source.video) {
        video.srcObject = source.video.srcObject;
        video.play?.().catch(() => {});
      }
      hud();
    },

    /** Остановить забег по просьбе человека. */
    pauseManual() {
      if (stage !== 'free' || manual) return;
      manual = true;
      run = RUN.paused;
      pauseWhy = null;
      /* Ручная пауза считается ступенью наравне с автоматической, хотя
         дефектом не является. Условие «ноль пауз» означает «забег прошёл
         подряд», а не «не было ошибок распознавания»: забег с пятиминутным
         перерывом посередине легче того же забега без перерыва, и повышать
         по нему нельзя. Считать только автопаузы значило бы ещё и развести
         журнал с самим собой — `pause why:"manual"` рядом с `pauses: 0`. */
      pauses++;
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
      /* Прошлое состояние флага нужно ДО того, как мы его взведём: `stop()`
         зовётся дважды легко — `abortRun` обнуляет ссылку на тренировку уже
         после `await`, и второе нажатие «В главное меню» успевает войти сюда
         снова. Без этой памяти ступень уезжала бы на два шага за один забег,
         а в журнал попадали бы два события об одном. Поймано ревью. */
      const ужеОстановлен = stopped;
      stopped = true;
      /* Брошенный забег тоже попадает в журнал. Ступень он больше никуда не
         двигает — её двигает рука взрослого, — но числа брошенного забега
         как раз и говорят, почему его бросили: именно они отвечают на вопрос
         «та ли сложность». `finished: false` их и помечает.

         Только из самого забега: на штативе и калибровке препятствий нет, и
         лишнее событие завелось бы на каждом входе в меню. */
      if (!ужеОстановлен && stage === 'free') logRun(false);
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
