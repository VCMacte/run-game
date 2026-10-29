// Кубок: лестница призов за собранные кольца.
//
// Уровень НЕ хранится — он вычисляется из копилки. Копилка монотонна и отката
// не имеет (см. docs/menu-and-navigation.md), значит множество открытого
// восстановимо из одного числа, и второй копии порогов не заводится. Список
// открытого в профиле был бы ровно той второй копией: поменяли порог — и у
// старых игроков рассогласование, которое видно только на второй сессии.
//
// Здесь нет ни DOM, ни хранилища, ни воркеров — по той же границе, по которой
// js/signals.js проверяется обычным node.
//
// Разбор: docs/trophy-and-worlds.md, docs/difficulty.md

import { WORLDS, worldReady } from './theme.js';
import { LEVELS, STEP_MAX, clampStep } from './difficulty.js';
import { OPTIONS } from './settings.js';

/** Шаг ПЕРВОГО круга в кольцах. Решение заказчика, не выведено ни из чего. */
export const STEP_RINGS = 100;

/** Шаг ВТОРОГО круга. Тоже решение заказчика, 27 октября: «новые уровни
    кубка должны проходиться за большее количество монет». */
export const STEP_RINGS_2 = 300;

/** Ступеней в круге: столько полос у кубка на экране. Второй круг
    перекрашивает те же двенадцать полос, а не рисует новые. */
export const CIRCLE = 12;

/** Порог ступени по её номеру с нуля. Формула одна на оба круга, и тест
    сверяет с ней таблицу — список порогов был бы второй копией шага. */
export const thresholdOf = (i) => (i < CIRCLE
  ? (i + 1) * STEP_RINGS
  : CIRCLE * STEP_RINGS + (i - CIRCLE + 1) * STEP_RINGS_2);

/* Таблица. Порядок = номер уровня, порог — `thresholdOf`, и формула эта
   проверяется тестом — список порогов был бы второй копией шага.

   `kind` отвечает на один вопрос: что открывает ступень.
     — `world`: мир, взаимоисключающий, выбирается;
     — `cosmetic`: внешность или звук, накопительна и действует сама;
     — `title`: звание, показывается последнее взятое;
     — `level`: уровень сложности, выбирается в меню.

   Здесь было «Вершина. Лестница конечная намеренно: уровни без призов
   обесценили бы те, за которыми приз есть», и 27 октября вершину отодвинули
   с 1200 на 4800. Опроверг её ребёнок: лестницу он прошёл до верха
   21 октября, а через неделю с копилкой 1625 спрашивал «а что дальше». Довод
   сохранён целиком: у каждой ступени второго круга приз есть, и ни один из
   них не рисуется в коридоре, то есть бюджет кадра второй круг не трогает.
   Лестница по-прежнему конечная, только длиннее.

   Имя мира здесь НЕ лежит: оно лежит в `WORLDS` в js/theme.js, вместе с его
   зонами. Две копии имени разъехались бы ровно так же, как разъезжаются две
   копии числа. Поэтому у мировых строк имени нет, а спрашивают его через
   `prizeName`.

   Цвета — половина палитры ЭКРАНОВ, не коридора: контракт DECISION/BACKGROUND
   на кубок не распространяется. Но светлота обязана строго возрастать от
   основания к вершине, с зазором 0.04, — это и проверяется. */
export const TROPHY = [
  { at: 100,  kind: 'cosmetic', id: 'sparks',  name: 'Искры',            color: '#1f4d2e' },
  { at: 200,  kind: 'cosmetic', id: 'bloom',   name: 'Цветущая обочина', color: '#2e6b3a' },
  { at: 300,  kind: 'world',    id: 'world-ice',   world: 'ice',         color: '#3f8c46' },
  { at: 400,  kind: 'cosmetic', id: 'fanfare', name: 'Фанфара',          color: '#57a341' },
  { at: 500,  kind: 'cosmetic', id: 'rim',     name: 'Ободок',           color: '#76b53c' },
  { at: 600,  kind: 'world',    id: 'world-deep',  world: 'deep',        color: '#9bc23e' },
  { at: 700,  kind: 'cosmetic', id: 'firefly', name: 'Светлячки',        color: '#c7c93f' },
  { at: 800,  kind: 'cosmetic', id: 'chime',   name: 'Звонкий сбор',     color: '#f2c94c' },
  { at: 900,  kind: 'world',    id: 'world-stars', world: 'stars',       color: '#f0d472' },
  { at: 1000, kind: 'cosmetic', id: 'buddy',   name: 'Спутник',          color: '#f4de96' },
  { at: 1100, kind: 'cosmetic', id: 'trail',   name: 'Шлейф',            color: '#f9e9b8' },
  { at: 1200, kind: 'cosmetic', id: 'gold',    name: 'Золотой кубок',    color: '#fff4d2' },

  /* Второй круг. Свой тон (синий к белому), чтобы круги не путались, но
     различает их не тон — цветность Miracast режет первой, — а звезда над
     чашей и строка «Второй круг». Светлота растёт строго ВНУТРИ круга. */
  { at: 1500, kind: 'title',    id: 'title-runner', name: 'Бегун',           color: '#1940b2' },
  { at: 1800, kind: 'level',    id: 'level-6',      step: 5,                 color: '#255cdb' },
  { at: 2100, kind: 'cosmetic', id: 'bell',         name: 'Колокольчик',     color: '#4379dc' },
  { at: 2400, kind: 'title',    id: 'title-walker', name: 'Скороход',        color: '#5a8fdd' },
  { at: 2700, kind: 'cosmetic', id: 'finale',       name: 'Большая фанфара', color: '#6ea1de' },
  { at: 3000, kind: 'world',    id: 'world-pixel',  world: 'pixel',          color: '#83b2e0' },
  { at: 3300, kind: 'level',    id: 'level-7',      step: 6,                 color: '#97c1e3' },
  { at: 3600, kind: 'cosmetic', id: 'bigbell',      name: 'Звон большого кольца', color: '#aacee5' },
  { at: 3900, kind: 'title',    id: 'title-champ',  name: 'Чемпион',         color: '#bbd9e9' },
  { at: 4200, kind: 'cosmetic', id: 'clean',        name: 'Песня чистого забега', color: '#cde3ed' },
  { at: 4500, kind: 'title',    id: 'title-hero',   name: 'Герой дороги',    color: '#dcedf2' },
  { at: 4800, kind: 'title',    id: 'title-legend', name: 'Легенда',         color: '#f1f7f9' },
];

/** Вершина — последняя строка таблицы, а не литерал: литерал 12 пережил бы
    рост таблицы и запер бы второй круг молча. */
export const TOP_LEVEL = TROPHY.length;

/** Имя приза для экрана. У мира берётся из реестра миров — там оно и живёт.

    Мир называется СТРОЧНЫМ словом и в кавычках: имя встаёт в чужую строку, и
    с прописным «Мир:» получалось двоеточие в двоеточии — «Следующий: Мир:
    Подводная долина» на экране кубка и «Открылось: Мир: Ледяные горы» на
    результате. Обе строки собираются подстановкой, поэтому чинится это здесь,
    у имени, а не в каждой строке порознь. */
export function prizeName(row) {
  if (!row) return '';
  if (row.kind === 'world') return `мир «${WORLDS?.[row.world]?.name || row.world}»`;
  /* Уровень сложности — по тому же правилу, что мир: имя живёт в реестре
     уровней (js/difficulty.js), а здесь только ссылка на него. */
  if (row.kind === 'level') return `уровень «${LEVELS[row.step]?.name || row.step + 1}»`;
  if (row.kind === 'title') return `звание «${row.name}»`;
  return row.name || row.id;
}

/** Уровень по копилке: 0…TOP_LEVEL. Мусор даёт 0 — один испорченный профиль не
    вправе уронить кубок.

    Счётом строк, а не делением: при двух шагах `floor(bank / 100)` врёт
    выше 1200, а порог и так живёт в таблице. */
export function levelAt(bank) {
  if (typeof bank !== 'number' || !Number.isFinite(bank) || bank <= 0) return 0;
  let lv = 0;
  while (lv < TROPHY.length && TROPHY[lv].at <= bank) lv++;
  return lv;
}

/** Круг и ступень внутри него — для полос на экране. Взятая вершина круга
    остаётся полным кругом (ступень 12 первого), а не становится пустым
    вторым: иначе ребёнок увидел бы обнулённый кубок ровно в момент победы. */
export function circleAt(bank) {
  const level = levelAt(bank);
  const circle = level > CIRCLE ? 1 : 0;
  return { circle, inCircle: level - circle * CIRCLE, level };
}

/* Набор открытого. Собирается ПЕРЕБОРОМ таблицы, а не списком полей: новая
   строка в TROPHY не должна требовать правки этой функции — иначе появится
   приз, который таблица обещает, а набор не отдаёт. */
export function unlockedAt(bank) {
  const lv = levelAt(bank);
  // Первый мир открыт всегда: в него и уходит забег, когда выбранный недоступен.
  const out = { worlds: ['hills'], titles: [], steps: [] };
  for (const row of TROPHY) if (row.kind === 'cosmetic') out[row.id] = false;
  for (let i = 0; i < lv; i++) {
    const row = TROPHY[i];
    if (row.kind === 'world') out.worlds.push(row.world);
    else if (row.kind === 'title') out.titles.push(row.name);
    else if (row.kind === 'level') out.steps.push(row.step);
    else out[row.id] = true;
  }
  return out;
}

/** Последнее взятое звание или null. */
export function titleAt(bank) {
  return unlockedAt(bank).titles.at(-1) ?? null;
}

/** Ступени сложности, которые стоят на лестнице, то есть заперты до порога.
    Все прочие открыты с первого запуска: путь ВНИЗ бесплатный всегда. */
export const LOCKED_STEPS = TROPHY.filter((r) => r.kind === 'level').map((r) => r.step);

/** Порог, на котором ступень открывается; 0 у открытой всегда. */
export function stepThreshold(step) {
  return TROPHY.find((r) => r.kind === 'level' && r.step === step)?.at ?? 0;
}

/** Открыта ли ступень при этой копилке. */
export function stepOpen(bank, step) {
  return !LOCKED_STEPS.includes(step) || unlockedAt(bank).steps.includes(step);
}

/** Ступень, на которой ПОЙДЁТ забег: выбранная, если открыта, иначе верхняя
    открытая ниже неё. Правило одно на старт забега и на экран выбора — по той
    же причине, что у `activeWorld`: выбранное когда-то при большей копилке
    (сменили игрока) обязано быть видно на экране тем, что пойдёт. */
export function activeStep(bank, wanted) {
  let s = clampStep(wanted);
  while (s > 0 && !stepOpen(bank, s)) s--;
  return s;
}

/** Медаль за чистый забег: ключ «ступень:мир» или null.

    Чистый — значит дошёл до финиша и ни разу не задел. Длина — только из
    меню (`OPTIONS.runLength`): отладочные 20–30 с медали не дают, иначе
    сетка заполнилась бы на машине разработки, а не у ребёнка. Прощённое
    препятствие ударом не считается: для ребёнка оно пройдено, очки целы. */
export function medalFor(result, world) {
  if (!result || result.hits !== 0) return null;
  const s = Math.round(result.durationS);
  if (!OPTIONS.runLength.some((o) => o.value === s)) return null;
  if (!Number.isInteger(result.step) || result.step < 0 || result.step > STEP_MAX) return null;
  if (typeof world !== 'string' || !WORLDS[world]) return null;
  return `${result.step}:${world}`;
}

/** Следующий уровень и остаток до него; на вершине — null. */
export function nextAt(bank) {
  const lv = levelAt(bank);
  if (lv >= TOP_LEVEL) return null;
  const row = TROPHY[lv];
  const имею = typeof bank === 'number' && Number.isFinite(bank) && bank > 0
    ? Math.floor(bank) : 0;
  return { level: lv + 1, at: row.at, left: row.at - имею, name: prizeName(row) };
}

/** Доступные миры. Первый — всегда. */
export function worldsAt(bank) {
  return unlockedAt(bank).worlds;
}

/** Мир, в котором ПОЙДЁТ забег: выбранный, если он открыт копилкой и собран,
    иначе первый.

    Правило одно на двоих — на старт забега и на экран выбора, — и живёт оно
    здесь по той же причине, по которой здесь живёт лестница: это чистая
    математика от копилки. Двумя копиями оно уже стояло наполовину: `startRun`
    правило знал, а экран выбора нет, и мир, выбранный когда-то при большей
    копилке, не отмечался на экране ничем. Ребёнок видел четыре кнопки и ни
    одной выбранной, а забег уходил в холмы — игра не показала того, что
    сделала. */
export function activeWorld(bank, wanted) {
  return typeof wanted === 'string' && worldsAt(bank).includes(wanted) && worldReady(wanted)
    ? wanted : 'hills';
}
