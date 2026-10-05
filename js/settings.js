// Настройки, которые крутит взрослый. Живут в localStorage, потому что
// родительское меню должно пережить перезапуск: подкручивать скорость после
// каждого включения никто не станет.
//
// Каждая настройка — список вариантов с подписью, а не число: в меню их
// переключают нажатием, а подпись сразу уходит на телевизор, и читать её будет
// взрослый с дивана. Поэтому подписи словами, а не цифрами.

const KEY = 'run-game.settings';

export const OPTIONS = {
  // Длина забега. Больше пяти минут для семи лет — уже физическая нагрузка,
  // а не игра, поэтому верхней границы выше нет.
  runLength: [
    { value: 180, label: '3 минуты' },
    { value: 240, label: '4 минуты' },
    { value: 300, label: '5 минут' },
  ],
  // Множитель базовой скорости. Время на решение от него не зависит:
  // дистанция появления препятствия пересчитывается вместе со скоростью.
  speed: [
    { value: 0.8, label: 'медленно' },
    { value: 1.0, label: 'обычно' },
    { value: 1.2, label: 'быстрее' },
  ],
  // Приседания можно выключить целиком: ребёнку может быть тяжело, и тогда
  // игра остаётся играбельной на одном боковом смещении.
  crouch: [
    { value: true, label: 'включены' },
    { value: false, label: 'выключены' },
  ],
  sound: [
    { value: 0.5, label: 'тихо' },
    { value: 0.8, label: 'обычно' },
    { value: 1.0, label: 'громко' },
  ],
};

const DEFAULTS = Object.fromEntries(
  Object.entries(OPTIONS).map(([k, list]) => [k, list[Math.min(1, list.length - 1)].value]),
);

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = read();

export const settings = {
  get: (name) => current[name],

  label(name) {
    const found = OPTIONS[name].find((o) => o.value === current[name]);
    return found ? found.label : String(current[name]);
  },

  /** Переключает настройку на следующий вариант по кругу и возвращает подпись. */
  cycle(name) {
    const list = OPTIONS[name];
    const i = list.findIndex((o) => o.value === current[name]);
    current[name] = list[(i + 1) % list.length].value;
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
    return this.label(name);
  },
};
