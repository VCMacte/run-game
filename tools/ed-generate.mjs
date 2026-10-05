// Клиент к локальному Easy Diffusion (http://localhost:9000).
//
// Перенесён без правок из соседнего проекта (интерактивные комиксы), где уже
// прожил шесть историй. Зачем свой клиент, а не веб-интерфейс: картинки нужно
// получать пачками с одинаковыми настройками и предсказуемыми именами файлов.
// Руками в браузере это не повторить — параметры разъезжаются от кадра к кадру.
//
// Здесь он нужен ровно для одного: небо и дальние холмы. Всё остальное в игре
// рисуется квадратами, потому что Stable Diffusion не умеет ни прозрачного
// фона, ни одинакового объекта между кадрами, а Miracast не прощает мелкой
// детали. Генерация идёт ТОЛЬКО img2img от init-полосы (tools/frame.html,
// ?band=1): горизонт обязан остаться на 46% высоты, иначе фон не сойдётся с
// полом. Генерация с нуля даёт красивую картинку с горизонтом где попало.
//
// Сервер поднимается только через Start-Process: из Git Bash `cmd //c` ломается
// на имени «Start Stable Diffusion UI.cmd» — cmd читает «Start» как свою
// встроенную команду.
//
// Запуск:
//   node tools/ed-generate.mjs --prompt "..." --out assets/test.png
//   node tools/ed-generate.mjs --prompt "..." --w 768 --h 448 --steps 30 --seed 7

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HOST = process.env.ED_HOST || 'http://localhost:9000';

/* ---------------- разбор аргументов ---------------- */

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

const a = args(process.argv.slice(2));

const opts = {
  prompt: a.prompt || 'a cute hedgehog in a moonlit forest, flat vector silhouette',
  negative: a.negative || 'text, watermark, signature, blurry, lowres, extra limbs, deformed',
  width: +(a.w || 512),
  height: +(a.h || 512),
  steps: +(a.steps || 25),
  guidance: +(a.cfg || 7.5),
  seed: a.seed ? +a.seed : Math.floor(Math.random() * 1e9),
  model: a.model || null,       // null — оставить тот, что выбран в настройках
  out: a.out || 'tools/out/test.png',
  init: a.init || null,         // img2img: от какой картинки отталкиваться
  strength: +(a.strength || 0.55),
  upscale: a.upscale === true ? 'RealESRGAN_x4plus' : (a.upscale || null),
};

/* ---------------- запросы ---------------- */

async function api(path, init) {
  const res = await fetch(HOST + path, init);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function pickModel() {
  if (opts.model) return opts.model;
  const data = await (await api('/get/models')).json();

  // Формат ответа у версий разный: сейчас это плоский список с тегами,
  // раньше были отдельные поля по типам моделей. Поддерживаем оба.
  let names = [];
  if (Array.isArray(data?.models)) {
    names = data.models
      .filter(m => (m.tags || []).includes('stable-diffusion'))
      .map(m => m.model ?? m.name);
  } else {
    const list = data?.options?.['stable-diffusion'] ?? data?.['stable-diffusion'] ?? [];
    names = list.map(m => (typeof m === 'string' ? m : m?.name ?? m?.path));
  }

  names = names.filter(Boolean);
  if (!names.length) throw new Error('Easy Diffusion не отдал ни одной модели');
  return names[0];
}

async function render(model) {
  const body = {
    prompt: opts.prompt,
    negative_prompt: opts.negative,
    width: opts.width,
    height: opts.height,
    seed: opts.seed,
    num_inference_steps: opts.steps,
    guidance_scale: opts.guidance,
    num_outputs: 1,
    sampler_name: 'euler_a',
    use_stable_diffusion_model: model,
    output_format: 'png',
    session_id: 'cli-' + Date.now(),
    stream_image_progress: false,
    show_only_filtered_image: true,
    metadata_output_format: 'none',
    block_nsfw: false,
    vram_usage_level: 'balanced',
  };

  // img2img: композиция берётся с готовой картинки, prompt_strength задаёт,
  // насколько сильно её переписывать. 0.5–0.6 сохраняет планы и линию земли.
  if (opts.init) {
    body.init_image = 'data:image/png;base64,' + readFileSync(resolve(opts.init)).toString('base64');
    body.prompt_strength = opts.strength;
  }

  if (opts.upscale) {
    body.use_upscale = opts.upscale;
    body.upscale_amount = 4;
  }

  const res = await api('/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * Поток отдаёт несколько JSON-объектов подряд, иногда склеенных в одном чанке,
 * иногда разорванных по границе. Поэтому копим текст и выбираем из него
 * последний цельный объект, а не парсим каждый кусок по отдельности.
 */
async function waitForImage(streamPath) {
  const deadline = Date.now() + 10 * 60_000;

  while (Date.now() < deadline) {
    const res = await fetch(HOST + streamPath);
    const text = await res.text();

    const objects = [];
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') { if (depth++ === 0) start = i; }
      else if (text[i] === '}') { if (--depth === 0 && start >= 0) objects.push(text.slice(start, i + 1)); }
    }

    for (const raw of objects.reverse()) {
      let obj;
      try { obj = JSON.parse(raw); } catch { continue; }
      if (obj.status === 'failed') throw new Error('Easy Diffusion: ' + (obj.detail || 'ошибка генерации'));
      const data = obj?.output?.[0]?.data;
      if (data) return data;
      if (obj.step != null && obj.total_steps) {
        process.stdout.write(`\r  шаг ${obj.step}/${obj.total_steps}   `);
      }
    }

    await new Promise(r => setTimeout(r, 700));
  }
  throw new Error('картинка не пришла за отведённое время');
}

/* ---------------- запуск ---------------- */

const t0 = Date.now();
const model = await pickModel();
console.log(`модель: ${model}`);
console.log(`размер: ${opts.width}×${opts.height}, шагов: ${opts.steps}, seed: ${opts.seed}`);

const task = await render(model);
if (!task.stream) throw new Error('Easy Diffusion не вернул ссылку на поток: ' + JSON.stringify(task).slice(0, 300));

const dataUrl = await waitForImage(task.stream);
const base64 = dataUrl.split(',')[1] ?? dataUrl;

const path = resolve(opts.out);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, Buffer.from(base64, 'base64'));

const kb = Math.round(Buffer.from(base64, 'base64').length / 1024);
console.log(`\nготово за ${((Date.now() - t0) / 1000).toFixed(1)} с -> ${opts.out} (${kb} КБ)`);
