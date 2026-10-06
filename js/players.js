/* Игроки: имя, своя калибровка, свои рекорды.

   Один модуль закрывает три задачи, и они связаны сильнее, чем кажется.

   Калибровка раньше хранилась одной записью на телефон, а играют двое:
   взрослый 173 см и ребёнок 100–130 см. Каждый забег взрослого затирал
   калибровку ребёнка, и тот проходил двадцать секунд калибровки заново — при
   том что код переиспользования написан и работает. Привязать калибровку к
   игроку дешевле, чем угадывать по длине торса, кто перед камерой.

   Оттуда же берётся имя для таблицы рекордов: на финише его не надо набирать,
   оно уже выбрано перед забегом, и достаточно подтвердить.

   Хранилище — localStorage, как у настроек: записи крошечные, а IndexedDB
   здесь был бы нужен только журналу, который пишет на каждом кадре. Всё в
   try/catch, поэтому модуль импортируется в node без браузера и проверяется
   обычным скриптом. */

import { STORAGE } from './config.js';

/* Потолок имени. Не произвольный: таблица и экран результата уходят на
   телевизор зеркалированием, Miracast жмёт картинку, и длинное имя там
   превращается в кашу раньше, чем кончится строка. */
export const NAME_MAX = 12;

/* Потолок записей на игрока. Вытесняется ХУДШАЯ запись, а не самая старая:
   иначе десяток рутинных забегов вытеснит собственно рекорд, ради которого
   таблица и существует. */
export const RECORDS_MAX = 50;

/* Имя в том виде, в котором оно хранится и показывается.

   Второй trim после обрезки не лишний: «Богдан Иванов» длиннее потолка, и
   обрезка по букве оставила бы «Богдан Иван » с висящим пробелом на конце —
   он невидим в поле и виден в таблице. */
export function normalizeName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
}

/* Порядок в таблице. Сравниваются только забеги одной длины — сырые кольца
   между пятью минутами и одной несравнимы, — поэтому длина в сравнение не
   входит вовсе, её отбирает records(). */
export function rankRecords(records) {
  return [...records].sort((a, b) => (
    (b.stars - a.stars)          // больше колец
    || (a.hits - b.hits)         // при равенстве — меньше задетых
    || (b.at - a.at)             // и при полном равенстве свежее выше
  ));
}

/* Обрезка до потолка: уходит худшее по тому же правилу.

   Применять её ко ВСЕМ записям игрока разом нельзя, и это та же ошибка, от
   которой уберегает rankRecords: длина в сравнение не входит, потому что
   сравнивать забеги разной длины бессмысленно. Пятьдесят пятиминутных забегов
   по сотне колец вытеснили бы первый же трёхминутный с шестьюдесятью — молча,
   в момент записи, и таблица трёх минут осталась бы пустой навсегда. Поэтому
   потолок применяется ВНУТРИ одной длины, а записей у игрока может быть до
   max × число сыгранных длин. Это по-прежнему килобайты. */
export function capRecords(records, max = RECORDS_MAX) {
  const buckets = new Map();
  for (const r of records) {
    const key = Math.round(r.durationS);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const out = [];
  for (const group of buckets.values()) out.push(...rankRecords(group).slice(0, max));
  return out;
}

function fresh(name) {
  return {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: normalizeName(name) || 'Игрок',
    createdAt: Date.now(),
    calib: null,
    records: [],
  };
}

/* Перенос с прошлого формата: калибровка лежала одной записью на телефон.
   Старый ключ НЕ удаляется — откат на прошлую сборку должен находить её на
   месте, а стоит она килобайт. */
function migrate() {
  let calib = null;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE.calibration) || 'null');
    if (raw && raw.neutralX != null) calib = raw;
  } catch { /* нет так нет */ }
  const first = fresh('Игрок 1');
  first.calib = calib;
  return { v: 1, currentId: first.id, list: [first] };
}

function read() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORAGE.players) || 'null'); } catch { /* ниже */ }
  if (!raw || !Array.isArray(raw.list) || raw.list.length === 0) return migrate();
  const list = raw.list
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => ({
      id: p.id,
      name: normalizeName(p.name) || 'Игрок',
      createdAt: Number(p.createdAt) || Date.now(),
      calib: p.calib && p.calib.neutralX != null ? p.calib : null,
      records: Array.isArray(p.records) ? p.records.filter((r) => r && Number.isFinite(r.stars)) : [],
    }));
  if (list.length === 0) return migrate();
  const currentId = list.some((p) => p.id === raw.currentId) ? raw.currentId : list[0].id;
  return { v: 1, currentId, list };
}

let state = read();

function persist() {
  try { localStorage.setItem(STORAGE.players, JSON.stringify(state)); } catch { /* игра важнее */ }
}

function me() {
  return state.list.find((p) => p.id === state.currentId) || null;
}

const card = (p) => ({ id: p.id, name: p.name, hasCalib: !!p.calib, runs: p.records.length });

export const players = {
  all: () => state.list.map(card),
  current: () => {
    const p = me();
    return p ? card(p) : null;
  },
  name: () => me()?.name || 'Игрок',

  select(id) {
    if (!state.list.some((p) => p.id === id)) return false;
    state.currentId = id;
    persist();
    return true;
  },

  /* Добавление по имени. Совпадение без регистра — это тот же игрок, а не
     второй: иначе «Богдан» и «богдан» разойдутся двумя таблицами рекордов и
     двумя калибровками, и выяснится это только тогда, когда рекорд пропадёт.

     `select` выключается там, где имя спрашивают только ради подписи под
     результатом. Иначе гость, которому приписали его забег, становится
     текущим игроком — и у ребёнка следующий забег начинается с двадцати
     секунд калибровки по пустому профилю гостя. Ровно то, ради устранения
     чего профили и заводились. */
  add(rawName, { select = true } = {}) {
    const name = normalizeName(rawName);
    if (!name) return null;
    const same = state.list.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const p = same || fresh(name);
    if (!same) state.list.push(p);
    if (select) state.currentId = p.id;
    persist();
    return { id: p.id, name: p.name, created: !same };
  },

  /* Удаление последнего игрока запрещено: пустой список означал бы, что
     следующий же read() заново выполнит перенос и создаст «Игрок 1» с чужой
     калибровкой. */
  remove(id) {
    if (state.list.length <= 1) return false;
    const i = state.list.findIndex((p) => p.id === id);
    if (i < 0) return false;
    state.list.splice(i, 1);
    if (state.currentId === id) state.currentId = state.list[0].id;
    persist();
    return true;
  },

  // ── калибровка текущего игрока ──

  loadCalibration: () => me()?.calib || null,

  saveCalibration(cal) {
    const p = me();
    if (!p) return;
    p.calib = cal;
    persist();
  },

  clearCalibration() {
    const p = me();
    if (!p) return;
    p.calib = null;
    persist();
  },

  // ── рекорды ──

  /* Записывается только дошедший до финиша забег. Выход через паузу сюда не
     попадает вовсе — не фильтром, а тем, что его путь этого метода не зовёт. */
  addRecord({ durationS, stars, starsTotal, hits, playerId } = {}) {
    const p = playerId ? state.list.find((x) => x.id === playerId) : me();
    if (!p || !Number.isFinite(stars) || !Number.isFinite(durationS)) return null;
    const rec = {
      at: Date.now(),
      durationS: Math.round(durationS),
      stars: Math.round(stars),
      starsTotal: Math.round(starsTotal ?? 0),
      hits: Math.round(hits ?? 0),
    };
    p.records = capRecords([...p.records, rec]);
    persist();
    return rec;
  },

  /* Таблица одной длины: имя приклеивается здесь, а не хранится в записи —
     переименование игрока должно переименовать и его прошлые рекорды. */
  records(durationS) {
    const rows = [];
    for (const p of state.list) {
      for (const r of p.records) {
        if (Math.round(r.durationS) === Math.round(durationS)) rows.push({ ...r, name: p.name, playerId: p.id });
      }
    }
    return rankRecords(rows);
  },

  /** Длины забегов, по которым вообще есть записи. */
  lengths() {
    const set = new Set();
    for (const p of state.list) for (const r of p.records) set.add(Math.round(r.durationS));
    return [...set].sort((a, b) => a - b);
  },

  /* Только для тестов: перечитать хранилище. В игре состояние живёт на всю
     сессию, как у настроек. */
  reload() { state = read(); },
};
