export function clamp(x: number, min: number, max: number) {
  return Math.max(min, Math.min(max, x));
}

export function wrapPhase(x: number) {
  x %= Math.PI * 2;
  return x < 0 ? x + Math.PI * 2 : x;
}

export function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

export function randn() {
  // Box–Muller
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
}
