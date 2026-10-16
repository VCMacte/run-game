# Кубок, этап 3 — мир «Ледяные горы»

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Уровень 3 кубка (300 колец) перестаёт говорить «скоро»: открывается
второй мир из трёх зон — морозное утро, снежное поле и ночь с сиянием, — и
ребёнок выбирает его в меню перед забегом.

**Architecture:** Новых ФОРМ не заводится ни одной: ледяные зоны собраны из тех
же видов обочины (ель, камень, столб), что и холмы, поэтому бюджет кадра не
меняется и новой отрисовки нет. Весь мир — это три записи в `THEME`, три строки
в `SKY_FILES`, три растра неба и одна строка в `WORLDS.ice.zones`. Зажим
светлоты растра перестаёт узнавать ночь по ИМЕНИ и начинает читать поле зоны —
иначе вторая тёмная зона потребовала бы второго `if`.

**Tech Stack:** Голые ES-модули без сборщика. Тесты — скрипты `node`
(`node tests-shell.mjs`, `node tests-control.mjs`). Арт: init-полоса из
`tools/frame.html?band=<зона>`, затем **только img2img** через
`tools/ed-generate.mjs` к локальному Easy Diffusion в `D:\EasyDiffusion`
(`http://localhost:9000`), затем перегон в WebP с зажимом светлоты. Офлайн-кэш
и версия — `node tools/make-sw.mjs`.

**Spec:** [`../specs/2026-10-16-trophy-and-worlds-design.md`](../specs/2026-10-16-trophy-and-worlds-design.md)

## Что выяснено до начала работы

Три факта, которые меняют порядок задач. Все проверены в коде, а не
предположены.

**Зона без файла неба роняет НАБОР, хотя игру не роняет.** Разбор прямо
говорит: нет растра — `drawSky` рисует полосы, и это не недоделка. Но группа
«тема» требует `SKY_FILES[зона]` для КАЖДОЙ зоны `THEME`, а набор оболочки
требует, чтобы названный файл лежал на диске и попал в офлайн-кэш. Значит зоны
и растры обязаны появиться ОДНИМ изменением, и растры должны получиться без
Easy Diffusion — иначе этап нельзя довести до зелёного без запущенного
стороннего сервера.

Выход — тот самый, которым в проекте уже собрана ночь: растр делается прямо из
init-полосы, через `toWebp`, без нейросети. Поэтому мир сперва собирается
полосами (Задача 2) и сразу играбелен, а Easy Diffusion проходит по двум
светлым зонам отдельной задачей (Задача 3). Ночь с сиянием через нейросеть не
идёт вовсе: она размазывает звёзды — это записано в разборе и подтверждено
ночными холмами.

**`?band=` умеет только зоны первого мира.** `tools/frame.html:124` берёт
`zonesOf('hills')`, то есть для ледяных зон init-полосу сделать нечем. Чинится
первой задачей, до того как зоны появятся.

**Снег обязан быть темнее проёма.** Фон держится ниже `gap` на `GAP_GUARD`, а
`gap` одинаков во всех зонах (`...DECISION`): потолок фона — **0.704**. Белый
снег `#e8f0f8` даёт 0.83 и контракт ломает. Палитры ниже уже прогнаны через
настоящий контракт: пять цветов пришлось притушить, нарушений в итоге ноль.

## Global Constraints

- **Порог мира — 300 колец**, миры стоят на 300, 600, 900 (`js/awards.js`).
- **Мир — ровно ТРИ зоны**, и каждая обязана существовать в `THEME`; каждая
  зона `THEME` обязана принадлежать какому-то миру — сличение двустороннее.
- **Все цвета РЕШЕНИЯ одинаковы во всех зонах побайтово** (`...DECISION`),
  фоновые `sky` и `floorA` обязаны различаться во ВСЕХ зонах — с шестью зонами
  это шесть разных небес и шесть разных полов.
- **Фон держится ниже проёма на `GAP_GUARD = 0.25`**, то есть потолок фоновых
  цветов — 0.704. Проверяется по каждой зоне и каждому ключу.
- **Зона задаёт ПОЛНЫЙ набор ключей палитры**, включая цвета форм, которых в
  ней нет: забытый ключ даёт `undefined` в `fillStyle`, и Canvas молча не
  рисует.
- **Худший кадр 117 при потолке 150 и мягком рубеже 120**; две копии числа
  (`CLAUDE.md` и счётчик) сверяются ТОЧНЫМ равенством.
- **Контракт растра один: горизонт на 46% высоты.** Генерация — только img2img
  от init-полосы; отношение сторон не обещано.
- **Зажим светлоты растра берётся у `skyClamp(зона)`**, числом в строке запуска
  не пишется: копия без владельца разойдётся с `GAP_GUARD`.
- **Easy Diffusion не стартует из Git Bash** — только `Start-Process`.
- **Списки офлайн-кэша и версия ГЕНЕРИРУЮТСЯ** (`node tools/make-sw.mjs`);
  `assets/*.webp` подхватываются обходом каталога сами.
- **Правка кода и документации едут ОДНИМ изменением**; «Разбор:» и «Код:»
  сверяются в обе стороны.
- **Приз не меняет приговор**: мир — это внешность, расстановка и пороги
  остаются общими.
- **Новый приз проверяется КАДРОМ, а не только счётчиком** — вывод этапа 2, где
  ободок был невидим, а счётчик этого не видел. `tools/frame.html?prizes=all`.
- **Не больше четырёх параллельных процессов.** Easy Diffusion — тяжёлый
  процесс: пока он работает, не запускать ни наборов, ни второго браузера.

## Review Focus

1. **Зона есть в `THEME`, но файла неба на диске нет** — игра обязана
   продолжиться полосами, а набор обязан этот разрыв назвать. → Задача 2.
2. **Вторая тёмная зона и зажим растра**: `skyClamp` узнавал ночь по ИМЕНИ
   (`zone === 'nightHills'`), и вторая тёмная зона молча получила бы дневной
   потолок 0.704 — белое сияние в ночном небе читалось бы дырой. → Задача 1.
3. **Выбранный мир открыт, но одна из его зон удалена из `THEME`** —
   `zonesOf` обязан отдать зоны первого мира, а не `undefined` в палитру
   кадра. → Задача 2.
4. **Худший кадр считается только по первому миру** — счётчик берёт
   `zoneAt(t, 300)` с умолчанием `hills`, поэтому зоны нового мира в бюджет не
   попадают вовсе, и перебор в них был бы не виден. → Задача 1.
5. **`?band=` для зоны не первого мира** — инструмент обязан дать полосу любой
   зоны, иначе арт нового мира нечем начать. → Задача 1.

---

### Task 1: Инфраструктура второго мира

**Files:**
- Modify: `js/theme.js` (`skyClamp` читает поле зоны; `SKY_CLAMP_NIGHT` уходит)
- Modify: `tools/frame.html:124` (`?band=` по любой зоне `THEME`)
- Modify: `tests-control.mjs` (группы «потолок светлоты растра», «бюджет кадра»)
- Modify: `docs/sky-and-art.md`, `docs/trophy-and-worlds.md`

**Interfaces:**
- Consumes: `WORLDS`, `zonesOf`, `kindsFor` (этап 1–2); `THEME`, `GAP_GUARD`.
- Produces:
  - поле зоны `skyClampTo?: number` — явный потолок светлоты растра
  - `skyClamp(zone)` — возвращает `skyClampTo` зоны, иначе `luminance(gap) − GAP_GUARD`
  - счётчик бюджета перебирает ВСЕ миры `WORLDS` с собранным артом

- [ ] **Step 1: Написать провальные тесты**

В `tests-control.mjs`, в группу «потолок светлоты растра», после проверки про
ночь:

```js
  /* Потолок берётся у ПОЛЯ зоны, а не по её имени. Имя работало, пока тёмная
     зона была одна; со вторым миром «ночь с сиянием» молча получила бы дневной
     потолок 0.704, и белое сияние читалось бы дырой в ночном небе — ровно тот
     отказ, от которого зажим и ставился. */
  check('ночной потолок задан полем зоны, а не её именем',
    THEME.nightHills.skyClampTo === skyClamp('nightHills'),
    `поле ${THEME.nightHills.skyClampTo}, функция ${skyClamp('nightHills')}`);
  check('и в коде не осталось сравнения с именем зоны',
    !readFileSync(join(ROOT, 'js/theme.js'), 'utf8').includes("zone === 'nightHills'"),
    'вторая тёмная зона потребовала бы второго if, и его забыли бы');
  /* У зоны без поля потолок по-прежнему выводится из проёма. */
  check('у дневной зоны поля нет', THEME.greenHill.skyClampTo === undefined);

  /* init-полосу можно сделать для ЛЮБОЙ зоны, а не только первого мира.
     Проверка текстовая, как и соседняя про `skyClamp` в примере сборки: HTML
     в node не исполняется. Без этого арт нового мира нечем начать — и
     выяснилось бы это в середине этапа, с уже написанными палитрами. */
  check('полосу можно снять с любой зоны палитры',
    frame.includes('Object.keys(THEME)') && !frame.includes("const ZONES = zonesOf('hills')"),
    'иначе ?band= знает только зоны первого мира');
```

(Переменная `frame` в этой группе уже есть — ею же проверяется пример сборки.)

В группу «бюджет кадра» — перебор миров. Заменить заголовок цикла:

```js
  for (const мир of Object.keys(WORLDS).filter((w) => worldReady(w))) {
   for (const seed of [1, 7, 13, 29]) {
    for (const step of [0, STEP_MAX]) {
```

и в вызовах внутри заменить `world: 'hills'` на `world: мир`, а
`zone: zoneAt(t, 300)` — на `zone: zoneAt(t, 300, мир)`; в строку отчёта
добавить мир:

```js
  console.log(`  худший кадр: ${worst} заливок при потолке ${CEILING}`
    + ` (мир ${worstWorld}, посев ${worstSeed}, ступень ${worstStep}, ${worstAt.toFixed(1)} с)`);
```

с новой переменной `let worstWorld = 'hills';`, которая пишется там же, где
`worstSeed`. Закрыть добавленный цикл соответствующей скобкой.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node tests-control.mjs`
Expected: `ПРОВАЛ ночной потолок задан полем зоны, а не её именем` и
`ПРОВАЛ и в коде не осталось сравнения с именем зоны`.

- [ ] **Step 3: Перевести `skyClamp` на поле зоны**

В `js/theme.js`, в зону `nightHills`, рядом с `skyStars: true`:

```js
    /* Явный потолок светлоты для РАСТРА неба этой зоны. Общий потолок
       (граница GAP_GUARD от проёма, 0.704) ночи не годится вовсе: белые
       облака при нём оказались бы многократно светлее самого светлого цвета
       её палитры и читались бы дырой в ночи. Вывести это из палитры нечем —
       честное исключение лучше выдуманной формулы.

       Полем, а не именем зоны в `skyClamp`: имя работало, пока тёмная зона
       была одна. Со вторым миром такая же зона появилась бы снова, и второй
       `if` просто забыли бы — а молчаливый дневной потолок в тёмной зоне
       виден только на телевизоре. */
    skyClampTo: 0.30,
```

Заменить саму функцию и убрать осиротевшую константу:

```js
export function skyClamp(zone) {
  const свой = THEME[zone]?.skyClampTo;
  return typeof свой === 'number' ? свой : luminance(THEME[zone].gap) - GAP_GUARD;
}
```

Строку `const SKY_CLAMP_NIGHT = 0.30;` удалить.

- [ ] **Step 4: Научить `?band=` любой зоне**

`tools/frame.html`, в блоке `if (q.has('band'))`:

```js
    /* Зона полосы — ЛЮБАЯ зона палитры, а не только первого мира. `?band=1`
       оставлен и значит первую зону: так в README записан весь ритуал сборки
       фона, и ломать его ради единообразия незачем.

       Здесь стояло `zonesOf('hills')`, и со вторым миром это значило бы, что
       init-полосу для ледяных зон сделать нечем, то есть арт нового мира
       нечем начать. */
    const ZONES = Object.keys(THEME);
    const zone = ZONES.includes(q.get('band')) ? q.get('band') : zonesOf('hills')[0];
```

В импорте `tools/frame.html` строки 51–53 оставить `zonesOf` (он ещё нужен для
умолчания) и добавить `THEME`, если его там нет.

- [ ] **Step 5: Запустить тесты**

Run: `node tests-control.mjs`
Expected: зелено; строка бюджета теперь называет мир — `(мир hills, посев 7, …)`
— и само число не изменилось: собранный мир пока один.

Run: `node tests-shell.mjs`
Expected: зелено.

- [ ] **Step 6: Документация**

В `docs/sky-and-art.md`, в абзац «И зажим у зон РАЗНЫЙ», добавить:

```markdown
**Зажим задаётся ПОЛЕМ зоны (`skyClampTo`), а не именем зоны в коде.** Это
разворот прежнего `zone === 'nightHills'`: имя работало, пока тёмная зона была
одна, а со вторым миром такая же зона появляется снова — и второй `if` просто
забыли бы. Отказ при этом молчаливый: тёмная зона получила бы дневной потолок
0.704, и белое в её небе читалось бы дырой; видно это только на телевизоре.
Зоне без поля потолок по-прежнему ВЫВОДИТСЯ из проёма.
```

В `docs/trophy-and-worlds.md`:

```markdown
## Бюджет кадра считается по КАЖДОМУ собранному миру

Счётчик брал `zoneAt(t, 300)` с умолчанием первого мира, то есть зоны нового
мира в бюджет не попадали вовсе — перебор в них был бы не виден. Теперь он
перебирает `WORLDS` и берёт только те миры, у которых арт собран
(`worldReady`): у остальных зон нет, мерить нечего.
```

- [ ] **Step 7: Коммит**

```bash
git add js/theme.js tools/frame.html tests-control.mjs docs/
git commit -m "Зажим растра — поле зоны, бюджет — по всем мирам"
```

---

### Task 2: Три ледяные зоны и небо из полос

**Files:**
- Modify: `js/theme.js` (три зоны, `WORLDS.ice.zones`, `SKY_FILES`)
- Create: `assets/sky-ice-morning.webp`, `assets/sky-snow.webp`, `assets/sky-aurora.webp`
- Create: `tools/init/band-iceMorning.png`, `band-snowField.png`, `band-auroraNight.png`
- Modify: `tests-control.mjs` (группа «кубок»)
- Modify: `docs/trophy-and-worlds.md`, `docs/view-and-zones.md`, `docs/sky-and-art.md`
- Generated: `sw.js`, `js/version.js`

**Interfaces:**
- Consumes: `skyClampTo` и `?band=<зона>` (Задача 1).
- Produces: зоны `iceMorning`, `snowField`, `auroraNight`; `WORLDS.ice.zones`
  со всеми тремя; три записи `SKY_FILES`.

- [ ] **Step 1: Написать провальные тесты**

В `tests-control.mjs`, в группу «кубок», после проверок про светлячков:

```js
  /* Второй мир СОБРАН: у него три зоны, они есть в палитре, и мир перестал
     быть обещанием. Это единственная проверка, которая отличает «мир
     объявлен» от «в мир можно побежать». */
  check('ледяной мир собран', worldReady('ice'));
  check('и в нём три зоны', (WORLDS.ice.zones || []).length === 3,
    String(WORLDS.ice.zones));
  for (const z of WORLDS.ice.zones || []) {
    check(`зона ${z} есть в палитре`, !!THEME[z]);
    check(`у зоны ${z} назван файл неба`, typeof SKY_FILES[z] === 'string');
  }
  /* Ночь с сиянием — вторая тёмная зона проекта, и потолок растра у неё СВОЙ.
     Общий дневной потолок сделал бы её небо дырой. */
  check('у ночи с сиянием свой потолок растра',
    skyClamp('auroraNight') < skyClamp('iceMorning') - 0.2,
    `сияние ${skyClamp('auroraNight')}, утро ${skyClamp('iceMorning')}`);

  /* Светлячки теперь в ДВУХ ночных зонах, и проверка про «одну зону» это
     учитывает: правило не «одна зона», а «не везде». В дневных зонах их
     по-прежнему нет — ни в холмах, ни в ледяных. */
  check('светлячки есть в обеих ночных зонах',
    kindsFor('nightHills', { firefly: true }).some((k) => k.kind === 'firefly')
    && kindsFor('auroraNight', { firefly: true }).some((k) => k.kind === 'firefly'));
  for (const z of ['greenHill', 'sunsetDunes', 'iceMorning', 'snowField']) {
    check(`и нет в дневной зоне ${z}`,
      !kindsFor(z, { firefly: true }).some((k) => k.kind === 'firefly'),
      'светлячок в полдень — недоразумение, а не приз');
  }

  /* Зона, выпавшая из палитры, не должна отдавать undefined в кадр: такой
     мир считается несобранным и уступает первому — молча. */
  {
    const сохранено = WORLDS.ice.zones;
    WORLDS.ice.zones = ['iceMorning', 'нет-такой-зоны', 'auroraNight'];
    check('мир с несуществующей зоной отдаёт зоны первого мира',
      String(zonesOf('ice')) === String(WORLDS.hills.zones),
      String(zonesOf('ice')));
    WORLDS.ice.zones = сохранено;
  }
```

и в импорт из `./js/theme.js` добавить `skyClamp`, если его там нет.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node tests-control.mjs`
Expected: `ПРОВАЛ ледяной мир собран`.

- [ ] **Step 3: Три зоны в палитре**

В `js/theme.js`, после зоны `nightHills`, добавить три записи. Цвета ниже уже
прогнаны через контракт проекта: все 30 фоновых ключей каждой зоны лежат под
0.704, а `sky` и `floorA` не совпадают ни с одной из шести зон.

```js
  /* ───────── Мир «Ледяные горы» (приз уровня 3, 300 колец) ─────────

     Три зоны одного мира идут тем же порядком, что и в холмах: светлое утро →
     день → ночь. Новых ФОРМ обочины здесь нет ни одной — ель, камень и столб
     те же, что в холмах, — поэтому мир не стоит кадру ничего, и новой
     отрисовки не появилось.

     Главное ограничение этих палитр названо прямо: снег обязан быть ТЕМНЕЕ
     проёма. Потолок фона 0.704 (проём 0.954 минус GAP_GUARD), а белый снег
     #e8f0f8 — это 0.83. Поэтому снег здесь голубовато-серый: пять цветов
     пришлось притушить, и проверено это контрактом, а не глазом. */
  iceMorning: {
    id: 'iceMorning',
    name: 'Морозное утро',
    ...DECISION,
    sky: '#6f9fc8', skyLow: '#a8c6dc', hills: '#8fa6bb', cloud: '#c3d6e4',
    starSky: '#c2d6e6', grass: '#b9cfdd', grassDark: '#93aec1',
    earthL: '#7f94a6', earthR: '#6b8192', earthDeep: '#4e606e',
    floorA: '#b3c9d8', floorB: '#9db5c6', floorMid: '#8aa2b3', floorFar: '#6f8698',
    shadow: '#5a6e7e', palmTrunk: '#6b5a4a', palmLeaf: '#5a8f7a', flower: '#d08fa8',
    totem: '#b0bcc6', post: '#8d9aa6', postMark: '#c6d2dc',
    cactus: '#5f9e86', rock: '#9fb0bd', spruce: '#2f6b5a', firefly: '#6b7a3a',
    badnik: '#7a5f8f', badnikMouth: '#3f2f4a', spike: '#9aa7b2',
    critter: '#8f7a5f', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'spruce', weight: 0.42, bloomWeight: 0.32, height: 2.4 },
        { kind: 'rock', weight: 0.30, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.28, height: 2.6 },
        { kind: 'bush', weight: 0, bloomWeight: 0.10, height: 0.7, out: 0.12 },
      ],
    },
  },

  snowField: {
    id: 'snowField',
    name: 'Снежное поле',
    ...DECISION,
    sky: '#9ec3dd', skyLow: '#c6dced', hills: '#a9bccb', cloud: '#c4dbea',
    starSky: '#bcd4e6', grass: '#c3d5e0', grassDark: '#a3b8c6',
    earthL: '#90a4b2', earthR: '#7c909e', earthDeep: '#5c6d79',
    floorA: '#c8dae6', floorB: '#aec4d3', floorMid: '#9ab0bf', floorFar: '#7f95a4',
    shadow: '#67798a', palmTrunk: '#6b5a4a', palmLeaf: '#5a8f7a', flower: '#d08fa8',
    totem: '#bcc8d2', post: '#98a5b1', postMark: '#c6d5e2',
    cactus: '#5f9e86', rock: '#aebccb', spruce: '#35705f', firefly: '#6b7a3a',
    badnik: '#7a5f8f', badnikMouth: '#3f2f4a', spike: '#a6b3be',
    critter: '#8f7a5f', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'rock', weight: 0.40, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.32, height: 2.6 },
        { kind: 'spruce', weight: 0.28, bloomWeight: 0.20, height: 2.4 },
        { kind: 'bush', weight: 0, bloomWeight: 0.08, height: 0.7, out: 0.12 },
      ],
    },
  },

  /* Ночь с сиянием — ВТОРАЯ тёмная зона проекта, и потолок растра у неё свой
     (`skyClampTo`), как у ночных холмов. Общий дневной потолок 0.704 сделал бы
     её небо дырой: белое сияние оказалось бы светлее всего в её палитре. */
  auroraNight: {
    id: 'auroraNight',
    name: 'Ночь с сиянием',
    ...DECISION,
    skyStars: true,
    skyClampTo: 0.30,
    sky: '#0e1c33', skyLow: '#1b3350', hills: '#22384f', cloud: '#2d4a66',
    starSky: '#c2d9ec', grass: '#2b4257', grassDark: '#1d3043',
    earthL: '#24323f', earthR: '#1b2733', earthDeep: '#121a23',
    floorA: '#3a5267', floorB: '#2c4154', floorMid: '#223445', floorFar: '#1a2836',
    shadow: '#101a24', palmTrunk: '#3f2e22', palmLeaf: '#245c33', flower: '#7a4a5e',
    totem: '#4a5a66', post: '#3d4a55', postMark: '#5e6f7d',
    cactus: '#2f5e4e', rock: '#3f4e5b', spruce: '#1a4a3c', firefly: '#8a9a4a',
    badnik: '#4a3a5a', badnikMouth: '#241b2c', spike: '#49555f',
    critter: '#5a4a3a', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'spruce', weight: 0.46, bloomWeight: 0.36, height: 2.4 },
        { kind: 'rock', weight: 0.26, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.28, height: 2.6 },
        { kind: 'bush', weight: 0, bloomWeight: 0.10, height: 0.7, out: 0.12 },
        // Светлячки — приз уровня 7; в ледяной ночи они тоже уместны.
        { kind: 'firefly', needs: 'firefly', weight: 0.16, height: 1.4, out: 0.20 },
      ],
    },
  },
```

В `WORLDS`:

```js
  ice:   { id: 'ice',   name: 'Ледяные горы',
           zones: ['iceMorning', 'snowField', 'auroraNight'] },
```

В `SKY_FILES`:

```js
  iceMorning: 'sky-ice-morning.webp',
  snowField: 'sky-snow.webp',
  auroraNight: 'sky-aurora.webp',
```

- [ ] **Step 4: Запустить тесты и прочитать, что сломалось**

Run: `node tests-control.mjs`
Expected: группа «кубок» зелёная; строка бюджета теперь называет худший кадр по
ДВУМ мирам. Если число изменилось — переписать его в `CLAUDE.md` этим же шагом
и сказать, чем оно изменилось.

Run: `node tests-shell.mjs`
Expected: ПРОВАЛЫ `небо sky-ice-morning.webp лежит на диске` (и два таких же) —
зон три, а растров ещё нет. Это и есть повод для следующего шага.

- [ ] **Step 5: Собрать три полосы и три растра**

Поднять сервер и браузер (две штуки — потолок процессов это позволяет, Easy
Diffusion здесь НЕ нужен):

```bash
node serve.js &
```

Для каждой из трёх зон открыть
`http://localhost:8099/tools/frame.html?band=iceMorning` (затем `snowField`,
затем `auroraNight`) и выполнить в консоли страницы:

```js
await saveFrame('tools/init/band-iceMorning.png');
await toWebp('tools/init/band-iceMorning.png', 'assets/sky-ice-morning.webp', 0.82,
             skyClamp('iceMorning'));
```

```js
await saveFrame('tools/init/band-snowField.png');
await toWebp('tools/init/band-snowField.png', 'assets/sky-snow.webp', 0.82,
             skyClamp('snowField'));
```

```js
await saveFrame('tools/init/band-auroraNight.png');
await toWebp('tools/init/band-auroraNight.png', 'assets/sky-aurora.webp', 0.82,
             skyClamp('auroraNight'));
```

Зажим берётся ВЫЗОВОМ `skyClamp(зона)`, числом не пишется: копия без владельца
разойдётся с `GAP_GUARD` — это правило и проверяется тестом.

Погасить сервер за собой: он процесс, и правило потолка его считает.

- [ ] **Step 6: Пересобрать кэш и прогнать оба набора**

Run: `node tools/make-sw.mjs`
Expected: число файлов приложения выросло на три; `assets/*.webp`
подхватываются обходом каталога сами.

Run: `node tests-shell.mjs`
Expected: зелено — растры лежат на диске и попали в офлайн-кэш.

Run: `node tests-control.mjs`
Expected: зелено.

- [ ] **Step 7: Документация**

В `docs/trophy-and-worlds.md`:

```markdown
## Мир «Ледяные горы»

**Новых ФОРМ обочины в нём нет ни одной.** Ель, камень и столб — те же, что в
холмах, поэтому мир не стоит кадру ничего и новой отрисовки не появилось.
Отличается он палитрой и небом, а это ровно те две вещи, которые и делают зону
зоной.

**Снег обязан быть ТЕМНЕЕ проёма, и это главное ограничение палитры.** Потолок
фона — 0.704 (проём 0.954 минус `GAP_GUARD`), а белый снег `#e8f0f8` даёт 0.83.
Поэтому снег здесь голубовато-серый: пять цветов пришлось притушить. Проверено
контрактом по каждому из тридцати ключей, а не глазом.

**Ночь с сиянием — вторая тёмная зона проекта**, и потолок растра у неё свой
(`skyClampTo: 0.30`), как у ночных холмов. Общий дневной потолок сделал бы её
небо дырой: белое сияние оказалось бы светлее всего в её палитре. Разбор
самого зажима — в [`sky-and-art.md`](sky-and-art.md).

**Небо собрано из полос, без Easy Diffusion.** Так в проекте уже собрана ночь,
и для ледяного мира это не компромисс, а условие: зона без файла неба роняет
НАБОР (группа «тема» требует файл для каждой зоны, набор оболочки — файл на
диске), то есть мир нельзя довести до зелёного, пока растров нет. Светлые зоны
потом прошли через img2img отдельным заходом; ночь с сиянием через нейросеть не
идёт вовсе — она размазывает звёзды.
```

И там же — поправка к утверждению «светлячки принадлежат ОДНОЙ зоне»: ночных
зон стало две, и светлячки есть в обеих. Правило не изменилось («приз открыт»
не значит «везде»), изменилось число зон, которым он подходит; механизм тот же
`needs`, и проверка «их нет в дневных зонах» по-прежнему стоит.

В `docs/view-and-zones.md` — строка о том, что зон теперь шесть и палитра
проверяется по каждой; в `docs/sky-and-art.md` — что растров теперь шесть и
два из них собраны полосами.

- [ ] **Step 8: Коммит**

```bash
git add js/theme.js assets/ tools/init/ tests-control.mjs docs/ sw.js js/version.js
git commit -m "Мир «Ледяные горы»: три зоны, небо из полос, снег темнее проёма"
```

---

### Task 3: Два светлых неба через Easy Diffusion

**Files:**
- Modify: `assets/sky-ice-morning.webp`, `assets/sky-snow.webp` (замена)
- Create: `tools/painted/sky-ice-morning.png`, `tools/painted/sky-snow.png`
- Modify: `README.md`, `docs/sky-and-art.md`
- Generated: `sw.js`, `js/version.js`

**Interfaces:**
- Consumes: init-полосы из Задачи 2 (`tools/init/band-*.png`).
- Produces: ничего, что читает код, — только содержимое двух растров.

- [ ] **Step 1: Поднять Easy Diffusion**

Из Git Bash он не стартует: `cmd //c` ломается на имени «Start Stable Diffusion
UI.cmd» — `cmd` читает «Start» как свою встроенную команду. Только так:

```powershell
Start-Process cmd.exe -ArgumentList '/c','"D:\EasyDiffusion\Start Stable Diffusion UI.cmd"'
```

Дождаться, пока `http://localhost:9000` отвечает. Пока он работает, **не
запускать ни наборов, ни второго браузера**: это самый тяжёлый процесс в
проекте.

- [ ] **Step 2: Прогнать морозное утро**

```bash
node tools/ed-generate.mjs --init tools/init/band-iceMorning.png --strength 0.55 \
  --w 1024 --h 576 --steps 28 --out tools/painted/sky-ice-morning.png \
  --prompt "frosty winter morning sky over distant snowy mountain ridge, soft pale blue and rose clouds, flat vector poster style, clean horizon line, no text"
```

`--strength 0.55` — то же значение, которым собраны дневные зоны холмов:
сильнее размывает композицию полосы, слабее — не делает из плоских прямо-
угольников облаков.

- [ ] **Step 3: Прогнать снежное поле**

```bash
node tools/ed-generate.mjs --init tools/init/band-snowField.png --strength 0.55 \
  --w 1024 --h 576 --steps 28 --out tools/painted/sky-snow.png \
  --prompt "pale overcast winter sky over snowfield, soft grey-blue clouds, distant low snow hills, flat vector poster style, clean horizon line, no text"
```

- [ ] **Step 4: Погасить Easy Diffusion и перегнать в WebP**

Закрыть окно Easy Diffusion (или остановить его процесс) — дальше он не нужен,
а занимает он больше всего.

```bash
node serve.js &
```

В `http://localhost:8099/tools/frame.html` в консоли страницы:

```js
await toWebp('tools/painted/sky-ice-morning.png', 'assets/sky-ice-morning.webp', 0.82,
             skyClamp('iceMorning'));
await toWebp('tools/painted/sky-snow.png', 'assets/sky-snow.webp', 0.82,
             skyClamp('snowField'));
```

- [ ] **Step 5: Посмотреть ГЛАЗАМИ, что горизонт сошёлся**

Контракт растра — горизонт на 46% высоты, и нейросеть его сдвигает. В том же
браузере открыть кадр каждой зоны и убедиться, что небо сходится с полом, а не
висит ступенькой:

```
http://localhost:8099/tools/frame.html?zone=iceMorning&prizes=all
http://localhost:8099/tools/frame.html?zone=snowField&prizes=all
http://localhost:8099/tools/frame.html?zone=auroraNight&prizes=all
```

Если горизонт уехал — повторить Задачу 3 с `--strength 0.45`: чем меньше, тем
ближе результат к полосе, у которой горизонт на месте по построению. Если не
сходится и так — оставить растр из полосы (он уже лежит и работает), и записать
это в `docs/sky-and-art.md` как исход, а не как недоделку.

Погасить сервер за собой.

- [ ] **Step 6: Пересобрать кэш и прогнать наборы**

Run: `node tools/make-sw.mjs`
Run: `node tests-shell.mjs`
Run: `node tests-control.mjs`
Expected: оба зелёные. Число файлов не изменилось — растры заменены, а не
добавлены; версия сборки поднялась.

- [ ] **Step 7: Документация**

В `README.md`, в раздел про фон, добавить ритуал ледяного мира — он отличается
от холмов только именами:

```markdown
Ледяной мир собран тем же путём. Две светлые зоны идут через img2img:

```
# в браузере http://localhost:8099/tools/frame.html?band=iceMorning
#   -> await saveFrame('tools/init/band-iceMorning.png')
node tools/ed-generate.mjs --init tools/init/band-iceMorning.png --strength 0.55 \
  --w 1024 --h 576 --steps 28 --out tools/painted/sky-ice-morning.png --prompt "..."
# затем в tools/frame.html:
#   await toWebp('tools/painted/sky-ice-morning.png', 'assets/sky-ice-morning.webp',
#                0.82, skyClamp('iceMorning'))
```

А ночь с сиянием — БЕЗ нейросети, прямо из полосы, как и ночные холмы: звёзды
она размазывает.
```

В `docs/sky-and-art.md` — строка о том, что растров шесть, и что ночь с
сиянием собрана полосой по той же причине, что и ночные холмы.

- [ ] **Step 8: Коммит**

```bash
git add assets/ tools/painted/ README.md docs/ sw.js js/version.js
git commit -m "Два ледяных неба через img2img; ночь с сиянием — полосой"
```

---

### Task 4: Прогон, проверка кадром, ревью и состояние

**Files:**
- Modify: `docs/status.md`
- Modify: по итогам ревью — что укажет ревью

- [ ] **Step 1: Прогнать начисто**

Run: `node tools/make-sw.mjs`
Run: `node tests-shell.mjs`
Run: `node tests-control.mjs`
Expected: оба зелёные. **Сверить число проверок с 966 и 1759** — столько было
после этапа 2. «Всё сошлось» при нуле новых проверок выглядит так же, как при
тридцати.

- [ ] **Step 2: Пройти мир глазами, от меню до ночной зоны**

Это обязательный шаг, а не пожелание: на этапе 2 кадром в браузере нашлись два
приза, которых на экране не было вовсе, и счётчик заливок этого не видел.

```bash
node serve.js &
```

В браузере на `http://localhost:8099/?fake=walk` записать в `localStorage`
профиль с копилкой 1200 (ключ `run-game.players`, поля `bank: 1200`,
`world: 'hills'`), перезагрузить и проверить:

- кнопка «Мир:» в меню и экран «Куда побежим»: **«Ледяные горы» больше не
  говорят «скоро»** и выбираются;
- после выбора — что забег идёт в ледяных зонах;
- кадры всех трёх зон через `tools/frame.html?zone=<зона>&prizes=all`: проём
  остаётся самым светлым местом кадра, снег с ним не спорит, обочина читается.

Погасить сервер за собой.

- [ ] **Step 3: Код-ревью**

Run: `/code-review`

Ревью идёт ДО завершающего коммита: найденное после коммита превращается в
отдельный заход, а отложенная правка неотличима от забытой.

- [ ] **Step 4: Закрыть замечания**

Каждое — либо исправить, либо отклонить с записанной причиной. На каждую правку
перепрогон обоих наборов.

- [ ] **Step 5: Обновить состояние**

В `docs/status.md`: этап 3 сделан, второй мир открывается на 300 кольцах, зон
стало шесть, растров шесть. Отдельно — что ждёт прогона с ребёнком: читается ли
снег на телевизоре, не спорит ли он с проёмом после Miracast, замечает ли
ребёнок смену мира вообще.

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "Этап 3 кубка: правки по ревью и состояние"
```

---

## Что НЕ делается на этапе 3

Миры «Подводная долина» (600) и «Звёздная дорога» (900) — этап 5; обе зоны там
тёмные, и это самый опасный этап для контракта палитры. Спутник (1000) и шлейф
(1100) — этап 4. Золотой кубок (1200) — этап 6.

Семь отложенных мелочей ревью этапа 2 сюда тоже не входят, кроме одной, которая
становится заметной именно сейчас: `tools/log-report.mjs` не печатает
`world`/`level` из `run.start`. До этого этапа все забеги шли в одном мире и
сравнивать было нечего; теперь миров два, и первый же журнал с ребёнком
окажется неразборчивым по мирам. Если браться — то в Задаче 4, одной строкой
рядом с `screenRun` и `step`.
