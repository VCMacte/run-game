// Иконки приложения. Собираются из байтов, а не рисуются в редакторе:
// растеризатора SVG на машине нет, а тащить зависимость ради трёх картинок
// незачем. Заодно генератор детерминирован — diff иконки осмыслен.
//
//   node tools/make-icons.mjs        (строго из корня проекта: пути от cwd)
//
// Рисунок — мордочка Шустрика, талисмана игры. Она же стоит встроенным SVG в
// index.html и она же выскакивает из бадника в забеге (js/view.js): три места,
// три разные среды, и слить их в один источник нечем. ЦВЕТА при этом общие —
// берутся отсюда, из js/theme.js, — а форму приходится держать руками.
// Правило записано в CLAUDE.md: «мордочка в трёх местах».
//
// Крупные плоские формы: иконка должна читаться и в списке приложений, и
// после сжатия трансляции.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { THEME } from '../js/theme.js';

/* Цвета зверька не дублируются числами: разъехавшись с палитрой, иконка стала
   бы зверьком другой масти, и заметить это можно было бы только глазами.

   Фон — исключение, и честное: это `--bg` из css/style.css, а CSS отсюда не
   импортируется. Значит он тут ЧИСЛОМ, и совпадение двух литералов сторожит
   проверка в tests-shell.mjs — иначе иконка однажды разойдётся с заставкой и
   с меню молча. Цвет светлый небесный, но НЕ `sky` первой зоны (#4aa6dd):
   тот насыщеннее и для листа, который держат в руке, слишком тёмен. */
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const T = THEME.greenHill;
const BG = hex('#c6e2f4');        // = --bg в css/style.css
const FUR = hex(T.critter);
const EAR = hex(T.palmTrunk);
const MUZZLE = hex(T.gap);
const EYE = hex(T.badnikMouth);

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // бит на канал
  ihdr[9] = 2;   // truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // фильтр None: картинка плоская, предсказание ничего не даст
    for (let x = 0; x < width; x++) {
      const c = rgb(x, y);
      raw[row + 1 + x * 3] = c[0];
      raw[row + 2 + x * 3] = c[1];
      raw[row + 3 + x * 3] = c[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// pad — доля поля, свободная по краям. Для maskable Android обрезает до 20%
// с каждой стороны, поэтому рисунок там поджимается внутрь.
//
// Единицы внутри — доли рисунка: голова, два уха, светлая мордочка, два глаза
// и нос. Те же доли, что у символа в index.html, только там они на сетке 100.
function shustrik(size, pad) {
  const inner = size * (1 - 2 * pad);
  const off = size * pad;
  const disc = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

  return (px, py) => {
    const x = (px - off) / inner;
    const y = (py - off) / inner;
    if (x < 0 || x > 1 || y < 0 || y > 1) return BG;

    // Порядок обратный порядку рисования: сначала то, что сверху.
    if (disc(x, y, 0.50, 0.63, 0.045)) return EYE;      // нос
    if (disc(x, y, 0.37, 0.50, 0.060)) return EYE;      // глаза
    if (disc(x, y, 0.63, 0.50, 0.060)) return EYE;
    // Мордочка — эллипс, поэтому своя мерка по осям.
    if (((x - 0.50) / 0.19) ** 2 + ((y - 0.70) / 0.14) ** 2 <= 1) return MUZZLE;
    // Внутренняя часть уха выше головы, а не ниже: голова краем заходит на
    // ухо, и при обратном порядке она откусывала от коричневого кружка
    // ломтик — ухо читалось щербатым.
    if (disc(x, y, 0.25, 0.27, 0.07)) return EAR;
    if (disc(x, y, 0.75, 0.27, 0.07)) return EAR;
    if (disc(x, y, 0.50, 0.57, 0.33)) return FUR;       // голова
    if (disc(x, y, 0.25, 0.27, 0.15)) return FUR;       // уши
    if (disc(x, y, 0.75, 0.27, 0.15)) return FUR;
    return BG;
  };
}

/* Сглаживание: 3×3 подвыборки на пиксель со средним.

   Коридору оно было не нужно — он собран из прямых, и ступенек на них не
   видно. У зверька сплошные дуги, и без сглаживания на 192 пикселях ухо идёт
   лесенкой. Детерминированность сохраняется: сетка подвыборок фиксирована,
   случайности нет, зависимостей не прибавилось. */
function smooth(sample) {
  const grid = [0.1667, 0.5, 0.8333];
  return (px, py) => {
    let r = 0, g = 0, b = 0;
    for (const dy of grid) {
      for (const dx of grid) {
        const c = sample(px + dx, py + dy);
        r += c[0]; g += c[1]; b += c[2];
      }
    }
    return [Math.round(r / 9), Math.round(g / 9), Math.round(b / 9)];
  };
}

mkdirSync('icons', { recursive: true });
const made = [];
for (const [name, size, pad] of [
  ['icon-192.png', 192, 0.06],
  ['icon-512.png', 512, 0.06],
  ['icon-512-maskable.png', 512, 0.20],
]) {
  const file = `icons/${name}`;
  writeFileSync(file, png(size, size, smooth(shustrik(size, pad))));
  made.push(`${file} ${size}×${size}`);
}
console.log(made.join('\n'));
