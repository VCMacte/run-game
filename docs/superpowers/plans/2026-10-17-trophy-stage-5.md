# Кубок, этап 5 — миры «Подводная долина» и «Звёздная дорога»

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Уровни 6 и 9 кубка перестают говорить «скоро»: на 600 кольцах
открывается подводная долина, на 900 — звёздная дорога. Миров становится
четыре, зон — двенадцать.

**Architecture:** Та же схема, что у ледяных гор, и ни одной новой ФОРМЫ
обочины: оба мира собраны из камня, столба, ели, куста, цветка, тотема и
светлячков. Значит бюджет кадра не меняется и новой отрисовки нет. Каждый
мир — три записи в `THEME`, три строки в `SKY_FILES`, три растра и строка в
`WORLDS`. Небо сперва собирается ПОЛОСАМИ (мир сразу играбелен и набор
зелёный), а Easy Diffusion проходит по светлым зонам отдельной задачей.

**Tech Stack:** Голые ES-модули. Тесты — `node tests-shell.mjs`,
`node tests-control.mjs`. Арт: init-полоса `tools/frame.html?band=<зона>`,
только img2img через `tools/ed-generate.mjs` к Easy Diffusion в
`D:\EasyDiffusion`, перегон в WebP с зажимом. Кэш — `node tools/make-sw.mjs`.

**Спек:** [`../specs/2026-10-16-trophy-and-worlds-design.md`](../specs/2026-10-16-trophy-and-worlds-design.md)

## Что сделано до начала работы

**Все шесть палитр уже прогнаны через ПОЛНЫЙ контракт** — не только потолок
светлоты, но и каждое правило группы «зоны»: детали на плите вдвое отличимы от
её лица, зверёк отличим от кромки и хребта, спутник от неба, обочина от
силуэта хребта, шахматка пола больше 0.1, полосы пола лестницей вниз, пятно
между тёмной клеткой и глубиной обрыва, обрывы различимы, `sky` и `floorA`
уникальны среди ВСЕХ двенадцати зон. Нарушений ноль.

Это прямое следствие этапа 3, где контракт поймал четыре дефекта уже В РАБОТЕ.
Семь нарушений нашлись и здесь — но в черновике палитр, до единой строчки кода.

**Обе тёмные зоны получают свой `skyClampTo`:** светящаяся бездна и туманность
по 0.30, как обе ночные зоны; пояс комет — 0.45, он темнее дневных, но светлее
ночи. Механизм для этого ввёл этап 3.

## Global Constraints

- **Миры стоят на 300, 600, 900** (`js/awards.js`); этап закрывает два вторых.
- **Мир — ровно ТРИ зоны**, каждая обязана быть в `THEME`, и каждая зона
  `THEME` обязана принадлежать какому-то миру — сличение двустороннее.
- **Цвета РЕШЕНИЯ одинаковы во всех зонах побайтово** (`...DECISION`);
  `sky` и `floorA` обязаны различаться во всех двенадцати зонах.
- **Фон ниже проёма на `GAP_GUARD = 0.25`** — потолок фона 0.704.
- **Зона задаёт ПОЛНЫЙ набор ключей палитры**, включая цвета форм, которых в
  ней нет.
- **Худший кадр 118 при потолке 150 и мягком рубеже 120**; две копии числа
  сверяются ТОЧНЫМ равенством. Новых форм этап не вводит — число меняться не
  должно, а если изменилось, это находка.
- **Контракт растра: горизонт на 46% высоты**, генерация только img2img.
- **Зажим светлоты берётся у `skyClamp(зона)`**, числом не пишется.
- **Easy Diffusion не стартует из Git Bash** — только `Start-Process`. Если
  падает с `[WinError 233]` — смотреть `nvidia-smi`: это занятая видеопамять, а
  не промпт.
- **Приз проверяется КАДРОМ, а не только счётчиком** — за прогон счётчик
  трижды не увидел невидимый приз.
- **Правка кода и документации едут ОДНИМ изменением.**
- **Не больше четырёх параллельных процессов**; при работе Easy Diffusion —
  рядом ничего.

## Review Focus

1. **Двенадцать зон и уникальность `sky`/`floorA`** — проверка требует, чтобы
   совпадений не было НИ У ОДНОЙ пары; с ростом числа зон это первое, что
   ломается. → Задачи 1 и 2.
2. **Три тёмные зоны подряд** (бездна, туманность, пояс комет): у каждой свой
   `skyClampTo`, и ни одна не должна получить дневной потолок молча. → Задача 2.
3. **Мир объявлен, но арт не собран** — `worldReady` обязан вернуть false, а
   экран выбора сказать «скоро», а не пустить в мир без зон. → Задача 1.
4. **Бюджет кадра по ЧЕТЫРЁМ мирам** — счётчик перебирает собранные миры, и с
   двенадцатью зонами прогон вчетверо длиннее; худший кадр может переехать в
   новый мир. → Задача 2.
5. **Светлячки в трёх ночных зонах** — правило «не везде» остаётся, но дневных
   зон теперь восемь, и проверка обязана идти по всем. → Задача 2.

---

### Task 1: Мир «Подводная долина» (600)

**Files:**
- Modify: `js/theme.js` (три зоны, `WORLDS.deep.zones`, `SKY_FILES`)
- Create: `assets/sky-reef.webp`, `assets/sky-kelp.webp`, `assets/sky-abyss.webp`
- Create: `tools/init/band-reefShallow.png`, `band-kelpDeep.png`, `band-abyssGlow.png`
- Modify: `tests-control.mjs` (группа «кубок»)
- Modify: `docs/trophy-and-worlds.md`
- Generated: `sw.js`, `js/version.js`

**Interfaces:**
- Consumes: `skyClampTo`, `?band=<любая зона>`, `worldReady` (этапы 1–3).
- Produces: зоны `reefShallow`, `kelpDeep`, `abyssGlow`; `WORLDS.deep.zones`;
  три записи `SKY_FILES`.

- [ ] **Step 1: Написать провальные тесты**

В `tests-control.mjs`, в группу «кубок», рядом с проверками ледяного мира:

```js
  /* Подводный мир СОБРАН. Та же проверка, что у ледяного: она отличает «мир
     объявлен» от «в мир можно побежать». */
  check('подводный мир собран', worldReady('deep'));
  check('и в нём три зоны', (WORLDS.deep.zones || []).length === 3,
    String(WORLDS.deep.zones));
  for (const z of WORLDS.deep.zones || []) {
    check(`зона ${z} есть в палитре`, !!THEME[z]);
    check(`у зоны ${z} назван файл неба`, typeof SKY_FILES[z] === 'string');
  }
  check('у светящейся бездны свой потолок растра',
    skyClamp('abyssGlow') < skyClamp('reefShallow') - 0.2,
    `бездна ${skyClamp('abyssGlow')}, мелководье ${skyClamp('reefShallow')}`);
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node tests-control.mjs`
Expected: `ПРОВАЛ подводный мир собран`.

- [ ] **Step 3: Три зоны в палитре**

В `js/theme.js`, после зоны `auroraNight`. Палитры ниже уже прогнаны через
ПОЛНЫЙ контракт — нарушений ноль:

```js
reefShallow: {
    id: 'reefShallow',
    name: 'Мелководье',
    ...DECISION,
    sky: '#4fb3c4', skyLow: '#8fd4dc', hills: '#3f8f9e', cloud: '#a9dde3',
    starSky: '#b0dde4', grass: '#55a88f', grassDark: '#2f7a66', earthL: '#3f7a84',
    earthR: '#2c5d66', earthDeep: '#17323a', floorA: '#8fd0cc', floorB: '#3d7a7c',
    floorMid: '#6bb3b2', floorFar: '#4e9496', shadow: '#2a5a5e', palmTrunk: '#6b5a4a',
    palmLeaf: '#2f8f6f', flower: '#e07aa8', totem: '#9ec4c8', post: '#7fb0b6',
    postMark: '#bfe0e4', cactus: '#4f9e86', rock: '#86a8ae', spruce: '#2f6b5a',
    firefly: '#6b7a3a', buddy: '#1f4a52', badnik: '#5a2f4a', badnikMouth: '#2e1726',
    spike: '#c9dde0', critter: '#e0a85f', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'rock', weight: 0.38, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.30, height: 2.6 },
        { kind: 'bush', weight: 0.22, bloomWeight: 0.32, height: 0.7, out: 0.12 },
        { kind: 'flower', weight: 0.10, bloomWeight: 0.20, height: 0.45, out: 0.22 },
      ],
    },
  },


  kelpDeep: {
    id: 'kelpDeep',
    name: 'Заросли',
    ...DECISION,
    sky: '#1d5c66', skyLow: '#2f7f86', hills: '#1a4a52', cloud: '#3f8f94',
    starSky: '#9ecfd4', grass: '#246b5c', grassDark: '#0f2f28', earthL: '#255259',
    earthR: '#15353b', earthDeep: '#0c1f24', floorA: '#59a39c', floorB: '#20534f',
    floorMid: '#44857f', floorFar: '#2f6a66', shadow: '#163c3a', palmTrunk: '#4a3a2a',
    palmLeaf: '#2a7a5e', flower: '#c76a92', totem: '#6f9ea2', post: '#5a8a90',
    postMark: '#9ec4c8', cactus: '#3f8f6a', rock: '#56767c', spruce: '#1f6b4a',
    firefly: '#7a8a3a', buddy: '#8fc2c8', badnik: '#4a2340', badnikMouth: '#261120',
    spike: '#b4d6da', critter: '#d99a4f', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'spruce', weight: 0.44, bloomWeight: 0.34, height: 2.4 },
        { kind: 'rock', weight: 0.26, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.30, height: 2.6 },
        { kind: 'bush', weight: 0, bloomWeight: 0.10, height: 0.7, out: 0.12 },
      ],
    },
  },


  abyssGlow: {
    id: 'abyssGlow',
    name: 'Светящаяся бездна',
    ...DECISION,
    skyStars: true,
    skyAurora: true,
    skyClampTo: 0.30,
    sky: '#07161f', skyLow: '#0e2a36', hills: '#102b33', cloud: '#17424e',
    starSky: '#a8d2dc', grass: '#153c3a', grassDark: '#0c2422', earthL: '#1b3a42',
    earthR: '#0e2229', earthDeep: '#060f14', floorA: '#3f7a80', floorB: '#15383c',
    floorMid: '#2f6066', floorFar: '#224a50', shadow: '#102a2e', palmTrunk: '#3a2c20',
    palmLeaf: '#1f5c46', flower: '#8a4a68', totem: '#4a6f76', post: '#5c8a90',
    postMark: '#86b2b8', cactus: '#2a6650', rock: '#3f6269', spruce: '#1a5c46',
    firefly: '#9aba5a', buddy: '#7fb4bc', badnik: '#3a1f33', badnikMouth: '#1c0f18',
    spike: '#a8ccd2', critter: '#d4913f', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'rock', weight: 0.34, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.28, height: 2.6 },
        { kind: 'spruce', weight: 0.22, bloomWeight: 0.16, height: 2.4 },
        { kind: 'bush', weight: 0, bloomWeight: 0.08, height: 0.7, out: 0.12 },
        { kind: 'firefly', needs: 'firefly', weight: 0.16, height: 1.4, out: 0.20 },
      ],
    },
  },
```

В `WORLDS` заменить строку подводного мира на:

```js
  deep:  { id: 'deep',  name: 'Подводная долина',
           zones: ['reefShallow', 'kelpDeep', 'abyssGlow'] },
```

В `SKY_FILES` добавить:

```js
  reefShallow: 'sky-reef.webp',
  kelpDeep: 'sky-kelp.webp',
  abyssGlow: 'sky-abyss.webp',
```

- [ ] **Step 4: Прогнать и прочитать, что сломалось**

Run: `node tests-control.mjs`
Expected: группа «кубок» зелёная; контракт палитры по девяти зонам зелёный —
палитры проверены заранее. Если что-то упало, правило названо в сообщении:
править цвет, а не проверку.

Run: `node tests-shell.mjs`
Expected: ПРОВАЛЫ `небо sky-reef.webp лежит на диске` и два таких же — зоны
есть, растров нет. Это повод для следующего шага.

- [ ] **Step 5: Собрать три полосы и три растра**

```bash
node serve.js &
```

Для каждой зоны открыть `http://localhost:8099/tools/frame.html?band=<зона>` и
выполнить в консоли страницы:

```js
await saveFrame('tools/init/band-reefShallow.png');
await toWebp('tools/init/band-reefShallow.png', 'assets/sky-reef.webp', 0.82,
             skyClamp('reefShallow'));
```

```js
await saveFrame('tools/init/band-kelpDeep.png');
await toWebp('tools/init/band-kelpDeep.png', 'assets/sky-kelp.webp', 0.82,
             skyClamp('kelpDeep'));
```

```js
await saveFrame('tools/init/band-abyssGlow.png');
await toWebp('tools/init/band-abyssGlow.png', 'assets/sky-abyss.webp', 0.82,
             skyClamp('abyssGlow'));
```

Зажим берётся ВЫЗОВОМ, числом не пишется. Погасить сервер за собой.

- [ ] **Step 6: Пересобрать кэш и прогнать оба набора**

Run: `node tools/make-sw.mjs`
Run: `node tests-shell.mjs`
Run: `node tests-control.mjs`
Expected: оба зелёные. Худший кадр не должен измениться — новых форм нет.

- [ ] **Step 7: Документация**

В `docs/trophy-and-worlds.md`:

```markdown
## Мир «Подводная долина»

**Ни одной новой формы обочины.** Камень, столб, ель и куст — те же, что в
холмах; мир отличается палитрой и небом, и потому не стоит кадру ничего.

**Светящаяся бездна — третья тёмная зона проекта**, и потолок растра у неё
свой (0.30), как у обеих ночных. Механизм ввёл этап 3, и здесь он впервые
применён к зоне, которая не называется ночью: тёмная — это свойство палитры, а
не имени.

**Палитры прогнаны через ПОЛНЫЙ контракт до написания кода.** На этапе 3
контракт поймал четыре дефекта уже в работе; здесь семь нарушений нашлись в
черновике — до единой строчки.
```

- [ ] **Step 8: Коммит**

```bash
git add js/theme.js assets/ tools/init/ tests-control.mjs docs/ sw.js js/version.js
git commit -m "Мир «Подводная долина»: три зоны, небо из полос"
```

---

### Task 2: Мир «Звёздная дорога» (900)

**Files:**
- Modify: `js/theme.js` (три зоны, `WORLDS.stars.zones`, `SKY_FILES`)
- Create: `assets/sky-cloudtop.webp`, `assets/sky-comet.webp`, `assets/sky-nebula.webp`
- Create: `tools/init/band-cloudTop.png`, `band-cometBelt.png`, `band-nebula.png`
- Modify: `tests-control.mjs`
- Modify: `docs/trophy-and-worlds.md`, `docs/view-and-zones.md`
- Generated: `sw.js`, `js/version.js`

**Interfaces:**
- Consumes: то же, что Задача 1.
- Produces: зоны `cloudTop`, `cometBelt`, `nebula`; `WORLDS.stars.zones`; три
  записи `SKY_FILES`.

- [ ] **Step 1: Написать провальные тесты**

```js
  /* Звёздный мир собран, и на нём лестница миров закрывается: все четыре. */
  check('звёздный мир собран', worldReady('stars'));
  check('и в нём три зоны', (WORLDS.stars.zones || []).length === 3,
    String(WORLDS.stars.zones));
  check('все четыре мира собраны',
    Object.keys(WORLDS).every((w) => worldReady(w)),
    Object.keys(WORLDS).filter((w) => !worldReady(w)).join(', ') || 'все');
  check('зон стало двенадцать', Object.keys(THEME).length === 12,
    `${Object.keys(THEME).length}`);

  /* Три тёмные зоны и ни одной с дневным потолком по ошибке. */
  for (const z of ['nightHills', 'auroraNight', 'abyssGlow', 'nebula']) {
    check(`у зоны ${z} потолок растра тёмный`, skyClamp(z) <= 0.45, `${skyClamp(z)}`);
  }

  /* Светлячки — в ночных зонах, и ни в одной из ВОСЬМИ дневных. */
  for (const z of ['greenHill', 'sunsetDunes', 'iceMorning', 'snowField',
                   'reefShallow', 'kelpDeep', 'cloudTop', 'cometBelt']) {
    check(`и нет в дневной зоне ${z}`,
      !kindsFor(z, { firefly: true }).some((k) => k.kind === 'firefly'),
      'светлячок в полдень — недоразумение, а не приз');
  }
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node tests-control.mjs`
Expected: `ПРОВАЛ звёздный мир собран`.

- [ ] **Step 3: Три зоны в палитре**

```js
cloudTop: {
    id: 'cloudTop',
    name: 'Над облаками',
    ...DECISION,
    sky: '#6a7fd4', skyLow: '#a3b0e6', hills: '#7f8fd0', cloud: '#c6cff0',
    starSky: '#d2daf2', grass: '#8f9ad6', grassDark: '#5f6bb0', earthL: '#5a63a8',
    earthR: '#3f4780', earthDeep: '#242a4e', floorA: '#b0bce8', floorB: '#4f5a9e',
    floorMid: '#8e9bd4', floorFar: '#6e7bbc', shadow: '#3f4880', palmTrunk: '#6b5a4a',
    palmLeaf: '#5a8f7a', flower: '#e08ac0', totem: '#b4bce0', post: '#8f98cc',
    postMark: '#cdd4ee', cactus: '#5f9e86', rock: '#9aa3d0', spruce: '#3f6b8a',
    firefly: '#8a9a4a', buddy: '#2f3566', badnik: '#4a2f6b', badnikMouth: '#241735',
    spike: '#b6c0e4', critter: '#e8b05a', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'bush', weight: 0.34, bloomWeight: 0.40, height: 0.7, out: 0.12 },
        { kind: 'post', weight: 0.30, height: 2.6 },
        { kind: 'totem', weight: 0.22, height: 1.1, out: 0.35 },
        { kind: 'flower', weight: 0.14, bloomWeight: 0.20, height: 0.45, out: 0.22 },
      ],
    },
  },


  cometBelt: {
    id: 'cometBelt',
    name: 'Пояс комет',
    ...DECISION,
    skyStars: true,
    skyClampTo: 0.45,
    sky: '#2a2f66', skyLow: '#454d8f', hills: '#333a73', cloud: '#5a63a3',
    starSky: '#cdd4f2', grass: '#3f4580', grassDark: '#262b56', earthL: '#333a6b',
    earthR: '#1f2447', earthDeep: '#12152b', floorA: '#7f88c4', floorB: '#333a73',
    floorMid: '#646ea8', floorFar: '#4e5790', shadow: '#242a52', palmTrunk: '#4a3a2a',
    palmLeaf: '#4a7f6a', flower: '#c77aa8', totem: '#8f97c8', post: '#6f78b4',
    postMark: '#b4bce0', cactus: '#4f8f76', rock: '#6a73a8', spruce: '#2f5f7a',
    firefly: '#8a9a4a', buddy: '#a8b0dc', badnik: '#3f2359', badnikMouth: '#1f112c',
    spike: '#c2c9ea', critter: '#e0a04f', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'rock', weight: 0.40, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.34, height: 2.6 },
        { kind: 'totem', weight: 0.26, height: 1.1, out: 0.35 },
      ],
    },
  },


  nebula: {
    id: 'nebula',
    name: 'Туманность',
    ...DECISION,
    skyStars: true,
    skyClampTo: 0.30,
    sky: '#1a0e2e', skyLow: '#331a4a', hills: '#2a1540', cloud: '#4a2a66',
    starSky: '#d6c2ea', grass: '#33204a', grassDark: '#1f122e', earthL: '#3a2456',
    earthR: '#1a0f28', earthDeep: '#0d0718', floorA: '#7a5aa3', floorB: '#281840',
    floorMid: '#553f73', floorFar: '#43305c', shadow: '#241433', palmTrunk: '#3a2c20',
    palmLeaf: '#3f6b5a', flower: '#b06a9a', totem: '#7f66a3', post: '#8f73b4',
    postMark: '#bfa8d6', cactus: '#3f7f66', rock: '#6a5290', spruce: '#2f5f7a',
    firefly: '#b48ad6', buddy: '#c2a8e0', badnik: '#4a1f3a', badnikMouth: '#240f1c',
    spike: '#d6c2ea', critter: '#e0a04f', shade: '#0b0d14',
    decor: {
      kinds: [
        { kind: 'rock', weight: 0.32, height: 0.6, out: 0.10 },
        { kind: 'post', weight: 0.30, height: 2.6 },
        { kind: 'spruce', weight: 0.22, bloomWeight: 0.16, height: 2.4 },
        { kind: 'firefly', needs: 'firefly', weight: 0.16, height: 1.4, out: 0.20 },
      ],
    },
  },
```

В `WORLDS`:

```js
  stars: { id: 'stars', name: 'Звёздная дорога',
           zones: ['cloudTop', 'cometBelt', 'nebula'] },
```

В `SKY_FILES`:

```js
  cloudTop: 'sky-cloudtop.webp',
  cometBelt: 'sky-comet.webp',
  nebula: 'sky-nebula.webp',
```

- [ ] **Step 4: Прогнать**

Run: `node tests-control.mjs`
Expected: группа «кубок» зелёная; бюджет считается теперь по ЧЕТЫРЁМ мирам и
прогон заметно длиннее. Если худший кадр переехал в новый мир — это находка, и
число в `CLAUDE.md` обязано её назвать.

Run: `node tests-shell.mjs`
Expected: три ПРОВАЛА про отсутствующие растры.

- [ ] **Step 5: Собрать три полосы и три растра**

```bash
node serve.js &
```

```js
await saveFrame('tools/init/band-cloudTop.png');
await toWebp('tools/init/band-cloudTop.png', 'assets/sky-cloudtop.webp', 0.82,
             skyClamp('cloudTop'));
```

```js
await saveFrame('tools/init/band-cometBelt.png');
await toWebp('tools/init/band-cometBelt.png', 'assets/sky-comet.webp', 0.82,
             skyClamp('cometBelt'));
```

```js
await saveFrame('tools/init/band-nebula.png');
await toWebp('tools/init/band-nebula.png', 'assets/sky-nebula.webp', 0.82,
             skyClamp('nebula'));
```

Погасить сервер за собой.

- [ ] **Step 6: Пересобрать кэш и прогнать**

Run: `node tools/make-sw.mjs`
Run: `node tests-shell.mjs`
Run: `node tests-control.mjs`
Expected: оба зелёные.

- [ ] **Step 7: Документация**

В `docs/trophy-and-worlds.md` — раздел про звёздный мир и строка о том, что
лестница миров закрыта: все четыре собраны. В `docs/view-and-zones.md` — что
зон стало двенадцать и контракт идёт по каждой.

- [ ] **Step 8: Коммит**

```bash
git add js/theme.js assets/ tools/init/ tests-control.mjs docs/ sw.js js/version.js
git commit -m "Мир «Звёздная дорога»: лестница миров закрыта"
```

---

### Task 3: Светлые небеса через Easy Diffusion

**Files:**
- Modify: `assets/sky-reef.webp`, `assets/sky-cloudtop.webp` (замена)
- Create: `tools/painted/sky-reef.png`, `tools/painted/sky-cloudtop.png`
- Modify: `README.md`, `docs/sky-and-art.md`
- Generated: `sw.js`, `js/version.js`

**Interfaces:**
- Consumes: init-полосы из Задач 1 и 2.
- Produces: ничего, что читает код, — только содержимое двух растров.

- [ ] **Step 1: Проверить видеопамять и поднять Easy Diffusion**

```powershell
nvidia-smi --query-gpu=memory.free --format=csv
Start-Process cmd.exe -ArgumentList '/c','"D:\EasyDiffusion\Start Stable Diffusion UI.cmd"'
```

Свободной памяти должно быть не меньше 4 ГБ. Если меньше — рендер упадёт с
`[WinError 233]`, и это НЕ ошибка промпта. Пока Easy Diffusion работает, рядом
не запускать ничего.

- [ ] **Step 2: Мелководье**

```bash
node tools/ed-generate.mjs --init tools/init/band-reefShallow.png --strength 0.55 \
  --w 1024 --h 576 --steps 28 --out tools/painted/sky-reef.png \
  --prompt "bright shallow tropical sea surface seen from below, soft turquoise light rays, gentle caustics, flat vector poster style, clean horizon line, no text"
```

- [ ] **Step 3: Над облаками**

```bash
node tools/ed-generate.mjs --init tools/init/band-cloudTop.png --strength 0.55 \
  --w 1024 --h 576 --steps 28 --out tools/painted/sky-cloudtop.png \
  --prompt "view above a sea of clouds at twilight, soft violet and blue cloud tops, distant horizon glow, flat vector poster style, clean horizon line, no text"
```

- [ ] **Step 4: Погасить Easy Diffusion и перегнать в WebP**

```bash
node serve.js &
```

В `http://localhost:8099/tools/frame.html` в консоли страницы:

```js
await toWebp('tools/painted/sky-reef.png', 'assets/sky-reef.webp', 0.82,
             skyClamp('reefShallow'));
await toWebp('tools/painted/sky-cloudtop.png', 'assets/sky-cloudtop.webp', 0.82,
             skyClamp('cloudTop'));
```

- [ ] **Step 5: Посмотреть ГЛАЗАМИ, что горизонт сошёлся**

```
http://localhost:8099/tools/frame.html?zone=reefShallow&prizes=all
http://localhost:8099/tools/frame.html?zone=cloudTop&prizes=all
```

Если горизонт уехал — повторить с `--strength 0.45`. Если не сходится и так —
оставить растр из полосы и записать это в `docs/sky-and-art.md` как исход.

Погасить сервер за собой.

- [ ] **Step 6: Пересобрать кэш и прогнать**

Run: `node tools/make-sw.mjs`
Run: `node tests-shell.mjs`
Run: `node tests-control.mjs`
Expected: оба зелёные; число файлов не изменилось — растры заменены.

- [ ] **Step 7: Документация**

В `README.md` — что растров двенадцать и какие зоны идут через img2img; в
`docs/sky-and-art.md` — что четыре тёмные зоны собраны полосами намеренно.

- [ ] **Step 8: Коммит**

```bash
git add assets/ tools/painted/ README.md docs/ sw.js js/version.js
git commit -m "Два светлых неба новых миров через img2img"
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
Expected: оба зелёные; число проверок заметно выросло — контракт идёт по
двенадцати зонам.

- [ ] **Step 2: Пройти оба мира кадром**

```bash
node serve.js &
```

Посмотреть глазами все шесть новых зон:

```
http://localhost:8099/tools/frame.html?zone=reefShallow&prizes=all
http://localhost:8099/tools/frame.html?zone=kelpDeep&prizes=all
http://localhost:8099/tools/frame.html?zone=abyssGlow&prizes=all
http://localhost:8099/tools/frame.html?zone=cloudTop&prizes=all
http://localhost:8099/tools/frame.html?zone=cometBelt&prizes=all
http://localhost:8099/tools/frame.html?zone=nebula&prizes=all
```

В каждой: проём остаётся самым светлым местом кадра, обочина читается, пол не
слился, спутник виден. Затем в самой игре (`/?fake=walk`) с копилкой 1200 —
что оба мира выбираются и больше не говорят «скоро».

Погасить сервер за собой.

- [ ] **Step 3: Код-ревью**

Run: `/code-review`

- [ ] **Step 4: Закрыть замечания**

Каждое — либо исправить, либо отклонить с записанной причиной.

- [ ] **Step 5: Обновить состояние**

В `docs/status.md`: этап 5 сделан, миров четыре, зон двенадцать, растров
двенадцать. Отдельно — что ждёт прогона с ребёнком.

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "Этап 5 кубка: правки по ревью и состояние"
```

---

## Что НЕ делается на этапе 5

Золотой кубок (1200) — этап 6, последний. Отложенные мелочи прошлых ревью сюда
не входят, кроме `tools/log-report.mjs`, который так и не печатает `world` и
`level`: миров теперь четыре, и журнал без них неразборчив. Если браться — то
в Задаче 4, одной строкой.
