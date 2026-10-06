// Журнал событий. Пишется на телефон, выгружается файлом, разбирается потом.
//
// Зачем вообще: телефон стоит на штативе, консоли у него нет, и необработанное
// исключение выглядит снаружи просто как «игра зависла». А главные числа
// проекта — время реакции ребёнка и здоровье конвейера — снимаются во время
// забега, когда смотреть на экран некому.
//
// Почему IndexedDB, а не localStorage: у localStorage около пяти мегабайт и
// синхронный доступ, то есть каждая запись подвешивает кадр — ровно то, что мы
// и собираемся измерять. IndexedDB асинхронный.
//
// Почему сброс на диск раз в две секунды, а не в конце забега: самые ценные
// записи — те, после которых приложение умерло. Их в памяти не остаётся.

import { count, SESSIONS } from './text.js';

const DB = 'run-game-log';
const VERSION = 1;

export const LIMITS = {
  bytes: 25 * 1024 * 1024, // 25 МБ
  sessions: 20,            // сессий приложения
  flushMs: 2000,
  /* Сколько одинаковых событий подряд склеивать в одно.

     Понадобилось после журнала 6 октября: одна ошибка в кадре дала 1478
     одинаковых записей и 313 КБ за 133 секунды. Потолки `trim` работают
     ЦЕЛЫМИ сессиями, поэтому такой поток вытесняет из журнала все прошлые
     сессии — то есть один дефект уносит с собой свидетельства остальных.

     Склейка не бесконечная: после 500 повторов копится следующая запись. Так
     видно, что поток продолжается, а не кончился, — иначе по журналу нельзя
     отличить «упало 500 раз» от «упало 500 раз и падает до сих пор». */
  repeat: 500,
};

// ─────────────────────────── доступ к базе ───────────────────────────

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('events')) {
        db.createObjectStore('events', { keyPath: 'k', autoIncrement: true })
          .createIndex('session', 'session');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

const ask = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// ───────────────────────────── сессия ─────────────────────────────

// Сессия — один запуск приложения, а не один забег: падение приложения тем и
// примечательно, что забег после него не закончился, и привязывать записи к
// забегу значило бы терять ровно интересные случаи.
const sessionId = Date.now();
const startedAt = new Date().toISOString();
const t0 = performance.now();

let queue = [];
// Отпечаток последнего события в очереди — чтобы не сериализовать его заново
// при каждом следующем. Сбрасывается вместе с очередью.
let prevKey = null;
let queuedBytes = 0;
let timer = 0;
let broken = false; // база недоступна — приватный режим, переполнение диска

const encoder = new TextEncoder();

/* Отпечаток события: всё, кроме времени и полей конверта.

   Сравнение по полям, а не по типу: две РАЗНЫЕ ошибки склеивать нельзя — из
   журнала исчезла бы вторая. Сериализацией, а не обходом: поля вложенные
   (`rows`, `probes`), и глубокое сравнение было бы третьей копией логики
   сравнения в проекте.

   Поля конверта названы с подчёркиванием не для красоты. `n` в этом проекте
   уже занято полезной нагрузкой — `skeleton` и `samples` считают им отсчёты,
   `countdown` им же сообщает секунды, — и счётчик повторов с тем же именем
   затирал бы её молча: два отсчёта подряд превратились бы в один «n: 4».

   Экспортируется ради проверки: очередь приватна, а решение «это тот же поток
   или новый» обязано быть под тестом. */
export function eventKey(e) {
  try {
    const { t, _n, _lastT, ...rest } = e;
    return JSON.stringify(rest);
  } catch { return null; }
}

/** Одинаковы ли два события с точностью до времени и счётчика повторов. */
export function sameEvent(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const ka = eventKey(a);
  return ka != null && ka === eventKey(b);
}

/** Ставит событие в очередь. Никогда не бросает: логирование не должно ронять игру. */
export function event(type, data) {
  if (broken) return;
  const e = { t: Math.round(performance.now() - t0), type, ...data };

  /* Повтор подряд — не новая запись, а счётчик у прошлой. Склейка живёт
     здесь, в общем месте, а не у вызывающих: непредвиденный поток событий —
     это и есть тот случай, который журнал обязан выдержать, и предвидеть его
     у каждого вызывающего по отдельности нельзя по определению.

     `t` первой записи не меняется: по нему видно, когда поток начался.
     `_lastT` говорит, когда пришёл последний повтор, иначе длительность
     потока по журналу не восстановить.

     Отпечаток прошлого события хранится готовым, а не считается заново: иначе
     на каждое событие приходилось бы две сериализации вместо одной, а самое
     частое событие здесь — `skeleton` с пачкой поз под `?record=1`. Журнал не
     имеет права есть кадры: ради этого он и асинхронный. */
  const prev = queue[queue.length - 1];
  const key = eventKey(e);
  if (prev && key != null && key === prevKey && (prev._n || 1) < LIMITS.repeat) {
    prev._n = (prev._n || 1) + 1;
    prev._lastT = e.t;
    return;
  }

  queue.push(e);
  prevKey = key;
  try { queuedBytes += encoder.encode(JSON.stringify(e)).length; } catch {}
  if (!timer) timer = setTimeout(flush, LIMITS.flushMs);
}

export async function flush() {
  clearTimeout(timer);
  timer = 0;
  if (broken || !queue.length) return;

  const batch = queue;
  queue = [];
  prevKey = null;
  queuedBytes = 0;

  try {
    const db = await open();
    const bytes = encoder.encode(JSON.stringify(batch)).length;
    const tx = db.transaction(['events', 'sessions'], 'readwrite');
    const events = tx.objectStore('events');
    for (const e of batch) events.add({ ...e, session: sessionId });

    const sessions = tx.objectStore('sessions');
    const prev = await ask(sessions.get(sessionId));
    sessions.put({
      id: sessionId,
      startedAt,
      ua: navigator.userAgent,
      events: (prev?.events || 0) + batch.length,
      bytes: (prev?.bytes || 0) + bytes,
      updatedAt: new Date().toISOString(),
    });
    await done(tx);
    await trim();
  } catch {
    // База не открылась — журнал молча выключается. Игра важнее журнала.
    broken = true;
  }
}

// ─────────────────────── потолок и автоочистка ───────────────────────

/* Чистится по двум условиям сразу: больше 20 сессий или больше 25 МБ. Без
   потолка через месяц телефон ребёнка забит журналами, и обнаружится это в
   самый неподходящий момент. Удаляются всегда самые старые: свежая запись
   полезнее, а падение, которое разбирают, случилось только что. */
export async function trim() {
  const db = await open();
  const tx = db.transaction(['sessions', 'events'], 'readwrite');
  const sessions = tx.objectStore('sessions');
  const all = (await ask(sessions.getAll())).sort((a, b) => a.id - b.id);

  let total = all.reduce((s, x) => s + (x.bytes || 0), 0);
  const doomed = [];

  // Текущую сессию не трогаем никогда: иначе журнал съест сам себя на длинном
  // забеге и останется пустым ровно тогда, когда нужен.
  const removable = all.filter((s) => s.id !== sessionId);

  for (const s of removable) {
    if (all.length - doomed.length <= LIMITS.sessions && total <= LIMITS.bytes) break;
    doomed.push(s);
    total -= s.bytes || 0;
  }

  if (doomed.length) {
    const store = tx.objectStore('events');
    const index = store.index('session');
    for (const s of doomed) {
      sessions.delete(s.id);
      await dropEvents(store, index, s.id);
    }
  }
  await done(tx);
  return doomed.length;
}

// Курсор продвигается в собственном onsuccess: continue() ничего не
// возвращает, результат приходит в тот же запрос.
function dropEvents(store, index, session) {
  return new Promise((resolve, reject) => {
    const req = index.openKeyCursor(IDBKeyRange.only(session));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ───────────────────────────── состояние ─────────────────────────────

export async function status() {
  if (broken) return { broken: true };
  try {
    const db = await open();
    const all = await ask(db.transaction('sessions').objectStore('sessions').getAll());
    const bytes = all.reduce((s, x) => s + (x.bytes || 0), 0) + queuedBytes;
    const events = all.reduce((s, x) => s + (x.events || 0), 0) + queue.length;
    const dates = all.map((s) => s.startedAt).sort();
    return {
      broken: false,
      sessions: all.length,
      events,
      bytes,
      share: bytes / LIMITS.bytes,
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
    };
  } catch {
    return { broken: true };
  }
}

// ───────────────────────────── выгрузка ─────────────────────────────

async function collect() {
  await flush();
  const db = await open();
  const tx = db.transaction(['sessions', 'events']);
  const sessions = (await ask(tx.objectStore('sessions').getAll())).sort((a, b) => a.id - b.id);
  const events = await ask(tx.objectStore('events').getAll());
  const bySession = new Map(sessions.map((s) => [s.id, { ...s, log: [] }]));
  for (const e of events.sort((a, b) => a.k - b.k)) {
    const { k, session, ...rest } = e;
    bySession.get(session)?.log.push(rest);
  }
  return {
    exportedAt: new Date().toISOString(),
    limits: LIMITS,
    sessions: [...bySession.values()],
  };
}

function download(blob, name) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Сохраняет журнал файлом и открывает «Поделиться».
 *
 * Именно в таком порядке и обязательно оба. Файл должен лечь на телефон
 * независимо от того, чем кончится шторка: её можно закрыть случайно,
 * промахнуться мимо Телеграма, передумать — и журнал не должен при этом
 * пропасть. А шторка нужна потому, что искать файл в «Загрузках» телефона
 * ради отправки — лишний шаг там, где и так всё делается на бегу.
 */
export async function save() {
  const data = await collect();
  const name = `run-game-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });

  const saved = download(blob, name);

  // Шторка требует «свежего» жеста пользователя. Сборка журнала выше занимает
  // миллисекунды, и в отведённые браузером секунды мы укладываемся — но если
  // когда-нибудь перестанем, share() откажет, а файл всё равно уже сохранён.
  let shared = 'unavailable';
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'Журнал «Беги!»',
        text: `Журнал событий «Беги!», ${count(data.sessions.length, SESSIONS)}`,
      });
      shared = 'shared';
    } catch (e) {
      shared = e?.name === 'AbortError' ? 'cancelled' : 'failed';
    }
  }

  return { name, bytes: blob.size, saved, shared, sessions: data.sessions.length };
}

export async function clear() {
  queue = [];
  prevKey = null;
  queuedBytes = 0;
  const db = await open();
  const tx = db.transaction(['sessions', 'events'], 'readwrite');
  tx.objectStore('sessions').clear();
  tx.objectStore('events').clear();
  await done(tx);
}

// ─────────────────── что пишется без отдельной просьбы ───────────────────

/* Жизненный цикл и ошибки пишутся всегда. Это и есть те события, ради которых
   журнал затевался: срыв полного экрана, гашение экрана, исключение — всё то,
   что на телефоне на штативе выглядит одинаково, как «игра сломалась». */
export function watchLifecycle() {
  event('session.start', {
    startedAt,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    installed: matchMedia('(display-mode: fullscreen)').matches
      || matchMedia('(display-mode: standalone)').matches,
    lang: navigator.language,
  });

  addEventListener('error', (e) => event('error', {
    message: String(e.message), source: e.filename, line: e.lineno, col: e.colno,
  }));
  addEventListener('unhandledrejection', (e) => event('error.promise', {
    reason: String(e.reason?.message || e.reason),
  }));

  addEventListener('visibilitychange', () => event('visibility', { state: document.visibilityState }));
  addEventListener('fullscreenchange', () => event('fullscreen', { on: !!document.fullscreenElement }));
  addEventListener('resize', () => event('resize', { w: innerWidth, h: innerHeight }));

  // Последний шанс записать: после pagehide страницу могут не разбудить.
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}
