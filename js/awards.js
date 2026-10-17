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
// Разбор: docs/trophy-and-worlds.md

import { WORLDS, worldReady } from './theme.js';

/** Шаг лестницы в кольцах. Решение заказчика, не выведено ни из чего. */
export const STEP_RINGS = 100;

/** Вершина. Лестница конечная намеренно: уровни без призов обесценили бы те,
    за которыми приз есть. */
export const TOP_LEVEL = 12;

/* Таблица. Порядок = номер уровня, порог = номер × шаг, и формула эта
   проверяется тестом — список порогов был бы второй копией шага.

   `kind` отвечает на один вопрос: приз это внешность или мир. Мир
   взаимоисключающий и выбирается, косметика накопительна и действует сама.

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
];

/** Имя приза для экрана. У мира берётся из реестра миров — там оно и живёт.

    Мир называется СТРОЧНЫМ словом и в кавычках: имя встаёт в чужую строку, и
    с прописным «Мир:» получалось двоеточие в двоеточии — «Следующий: Мир:
    Подводная долина» на экране кубка и «Открылось: Мир: Ледяные горы» на
    результате. Обе строки собираются подстановкой, поэтому чинится это здесь,
    у имени, а не в каждой строке порознь. */
export function prizeName(row) {
  if (!row) return '';
  if (row.kind === 'world') return `мир «${WORLDS?.[row.world]?.name || row.world}»`;
  return row.name || row.id;
}

/** Уровень по копилке: 0…TOP_LEVEL. Мусор даёт 0 — один испорченный профиль не
    вправе уронить кубок. */
export function levelAt(bank) {
  if (typeof bank !== 'number' || !Number.isFinite(bank) || bank <= 0) return 0;
  return Math.min(TOP_LEVEL, Math.floor(bank / STEP_RINGS));
}

/* Набор открытого. Собирается ПЕРЕБОРОМ таблицы, а не списком полей: новая
   строка в TROPHY не должна требовать правки этой функции — иначе появится
   приз, который таблица обещает, а набор не отдаёт. */
export function unlockedAt(bank) {
  const lv = levelAt(bank);
  // Первый мир открыт всегда: в него и уходит забег, когда выбранный недоступен.
  const out = { worlds: ['hills'] };
  for (const row of TROPHY) if (row.kind !== 'world') out[row.id] = false;
  for (let i = 0; i < lv; i++) {
    const row = TROPHY[i];
    if (row.kind === 'world') out.worlds.push(row.world);
    else out[row.id] = true;
  }
  return out;
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
