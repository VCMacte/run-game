// Иконки приложения. Собираются из байтов, а не рисуются в редакторе:
// растеризатора SVG на машине нет, а тащить зависимость ради четырёх картинок
// незачем. Заодно генератор детерминирован — diff иконки осмыслен.
//
//   node tools/make-icons.mjs
//
// Рисунок — тот же коридор, что и в игре: тёмный фон, светлый пол, уходящий
// в точку, и поперечные линии. Крупные плоские формы: иконка должна читаться
// и в списке приложений, и после сжатия трансляции.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0x0b, 0x0d, 0x14];
const FLOOR = [0x5a, 0xa9, 0xff];
const LINE = [0xf2, 0xf5, 0xff];

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
function corridor(size, pad) {
  const inner = size * (1 - 2 * pad);
  const off = size * pad;
  const horizon = 0.20;        // доля высоты рисунка, где сходится коридор
  const nearHalf = 0.50;       // половина ширины пола у ближнего края
  const farHalf = 0.028;       // и у горизонта
  const lines = [0.12, 0.33, 0.58, 0.87]; // поперечные линии, сгущаются к горизонту

  return (px, py) => {
    const x = (px - off) / inner;
    const y = (py - off) / inner;
    if (x < 0 || x > 1 || y < 0 || y > 1) return BG;
    if (y < horizon) return BG;

    const t = (y - horizon) / (1 - horizon);        // 0 у горизонта, 1 у ближнего края
    const half = farHalf + (nearHalf - farHalf) * Math.pow(t, 1.7); // показатель даёт перспективу
    if (Math.abs(x - 0.5) > half) return BG;

    // Поперечные линии: толщина растёт вместе с перспективой, иначе у горизонта
    // они исчезают в один пиксель и после сжатия пропадают совсем.
    for (const l of lines) {
      if (Math.abs(t - l) < 0.016 + 0.05 * l) return LINE;
    }
    return FLOOR;
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
  writeFileSync(file, png(size, size, corridor(size, pad)));
  made.push(`${file} ${size}×${size}`);
}
console.log(made.join('\n'));
