// Deterministic pseudo-random helpers so mock screens look the same on every load.

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rng = mulberry32(20261126);

export function pickWeighted<T>(items: readonly (readonly [T, number])[], r = rng): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x <= 0) return v;
  }
  return items[items.length - 1][0];
}

export function pick<T>(items: readonly T[], r = rng): T {
  return items[Math.floor(r() * items.length)];
}

export function hex(n: number, r = rng): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}

export function between(min: number, max: number, r = rng): number {
  return min + r() * (max - min);
}
