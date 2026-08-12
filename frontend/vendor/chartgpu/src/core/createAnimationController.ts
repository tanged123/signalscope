import type { EasingFunction } from '../utils/easing';

export type AnimationId = symbol;

export interface AnimationController {
  animate(
    from: number,
    to: number,
    duration: number,
    easing: EasingFunction,
    onUpdate: (value: number) => void,
    onComplete?: () => void
  ): AnimationId;
  animate(
    from: ReadonlyArray<number>,
    to: ReadonlyArray<number>,
    duration: number,
    easing: EasingFunction,
    onUpdate: (value: ReadonlyArray<number>) => void,
    onComplete?: () => void
  ): AnimationId;

  cancel(animationId: AnimationId): void;
  cancelAll(): void;

  /**
   * Progresses all active animations to `timestamp` (ms).
   * Intended to be called once per frame by the caller (e.g. a render loop).
   */
  update(timestamp: number): void;
}

type ScalarAnimation = Readonly<{
  kind: 'scalar';
  from: number;
  to: number;
  duration: number;
  easing: EasingFunction;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
  startTime: number | null;
}>;

type ArrayAnimation = Readonly<{
  kind: 'array';
  from: ReadonlyArray<number>;
  to: ReadonlyArray<number>;
  duration: number;
  easing: EasingFunction;
  onUpdate: (value: ReadonlyArray<number>) => void;
  onComplete?: () => void;
  startTime: number | null;
  out: number[];
}>;

type AnimationInternal = ScalarAnimation | ArrayAnimation;

const normalizeDurationMs = (duration: number): number => (Number.isFinite(duration) ? duration : 0);

const normalizeTimestampMs = (timestamp: number): number | null => (Number.isFinite(timestamp) ? timestamp : null);

export function createAnimationController(): AnimationController {
  const animations = new Map<AnimationId, AnimationInternal>();

  function animate(
    from: number | ReadonlyArray<number>,
    to: number | ReadonlyArray<number>,
    duration: number,
    easing: EasingFunction,
    onUpdate: ((value: number) => void) | ((value: ReadonlyArray<number>) => void),
    onComplete?: () => void
  ): AnimationId {
    const id: AnimationId = Symbol('Animation');

    if (Array.isArray(from) || Array.isArray(to)) {
      if (!Array.isArray(from) || !Array.isArray(to)) {
        throw new Error('Array animation requires both "from" and "to" to be arrays');
      }
      if (from.length !== to.length) {
        throw new Error(`Array animation length mismatch: from.length=${from.length}, to.length=${to.length}`);
      }

      const out = new Array<number>(from.length);
      animations.set(id, {
        kind: 'array',
        from,
        to,
        duration,
        easing,
        onUpdate: onUpdate as (value: ReadonlyArray<number>) => void,
        onComplete,
        startTime: null,
        out,
      });
      return id;
    }

    animations.set(id, {
      kind: 'scalar',
      from: from as number,
      to: to as number,
      duration,
      easing,
      onUpdate: onUpdate as (value: number) => void,
      onComplete,
      startTime: null,
    });
    return id;
  }

  function cancel(animationId: AnimationId): void {
    animations.delete(animationId);
  }

  function cancelAll(): void {
    animations.clear();
  }

  function update(timestamp: number): void {
    const ts = normalizeTimestampMs(timestamp);
    if (ts === null) return;

    // Snapshot IDs to tolerate cancellation during callbacks and to ensure
    // animations started during callbacks don't run until next tick.
    const ids = Array.from(animations.keys());
    for (const id of ids) {
      const anim = animations.get(id);
      if (!anim) continue; // cancelled

      const startTime = anim.startTime ?? ts;
      if (anim.startTime === null) {
        // Mutate by replacement to keep internal entries immutable-by-type.
        animations.set(id, { ...anim, startTime });
      }

      const durationMs = normalizeDurationMs(anim.duration);
      const elapsed = Math.max(0, ts - startTime);

      const shouldComplete = durationMs <= 0 || elapsed >= durationMs;
      const rawT = durationMs <= 0 ? 1 : elapsed / durationMs;
      const t = shouldComplete ? 1 : anim.easing(rawT);

      if (anim.kind === 'scalar') {
        const value = anim.from + (anim.to - anim.from) * t;
        anim.onUpdate(value);

        // Cancellation during callback should prevent onComplete.
        if (!animations.has(id)) continue;
      } else {
        const n = anim.out.length;
        for (let i = 0; i < n; i++) {
          const a = anim.from[i] ?? 0;
          const b = anim.to[i] ?? 0;
          anim.out[i] = a + (b - a) * t;
        }
        anim.onUpdate(anim.out);

        // Cancellation during callback should prevent onComplete.
        if (!animations.has(id)) continue;
      }

      if (shouldComplete) {
        anim.onComplete?.();
        // If it was cancelled inside onComplete, deletion is harmless.
        animations.delete(id);
      }
    }
  }

  return {
    animate: animate as AnimationController['animate'],
    cancel,
    cancelAll,
    update,
  };
}
