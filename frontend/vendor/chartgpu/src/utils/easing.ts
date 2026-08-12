export type EasingFunction = (t: number) => number;

import type { AnimationConfig } from '../config/types';

export type EasingName = NonNullable<AnimationConfig['easing']>;

const clamp01 = (t: number): number => {
  if (Number.isNaN(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
};

export function easeLinear(t: number): number {
  return clamp01(t);
}

export function easeCubicOut(t: number): number {
  const x = clamp01(t);
  const inv = 1 - x;
  return 1 - inv * inv * inv;
}

export function easeCubicInOut(t: number): number {
  const x = clamp01(t);
  // Standard easeInOutCubic:
  // - accelerating cubic for the first half
  // - decelerating cubic for the second half
  if (x < 0.5) return 4 * x * x * x;
  const y = -2 * x + 2;
  return 1 - (y * y * y) / 2;
}

export function easeBounceOut(t: number): number {
  const x = clamp01(t);
  // Standard easeOutBounce (Robert Penner) piecewise approximation.
  const n1 = 7.5625;
  const d1 = 2.75;

  if (x < 1 / d1) {
    return n1 * x * x;
  }
  if (x < 2 / d1) {
    const a = x - 1.5 / d1;
    return n1 * a * a + 0.75;
  }
  if (x < 2.5 / d1) {
    const a = x - 2.25 / d1;
    return n1 * a * a + 0.9375;
  }

  const a = x - 2.625 / d1;
  return n1 * a * a + 0.984375;
}

export function getEasing(name: AnimationConfig['easing'] | null | undefined): EasingFunction {
  switch (name) {
    case 'linear':
      return easeLinear;
    case 'cubicOut':
      return easeCubicOut;
    case 'cubicInOut':
      return easeCubicInOut;
    case 'bounceOut':
      return easeBounceOut;
    default:
      return easeLinear;
  }
}
