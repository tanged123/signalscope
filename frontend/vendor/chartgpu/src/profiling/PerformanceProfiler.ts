/**
 * PerformanceProfiler - lightweight span-based performance profiler for ChartGPU.
 *
 * Records named timing spans with category tagging, counter time-series, and
 * exports to the Chrome DevTools Trace Event Format for visualisation with
 * chrome://tracing or Perfetto UI.
 *
 * Design principles:
 * - Zero dependencies beyond the browser Performance API
 * - Functional-first API (createProfiler / measure / record*)
 * - No-op when disabled so production bundles pay no overhead
 * - Circular span buffer to bound memory usage at configurable capacity
 */

import type { CounterSample, ProfileSpan, ProfilerSnapshot, SpanStats, TraceEvent, TraceExport } from './types';

/** Maximum spans retained in the circular buffer (default). */
const DEFAULT_MAX_SPANS = 10_000;

/** Maximum counter samples retained (default). */
const DEFAULT_MAX_COUNTERS = 5_000;

/** Fake process/thread IDs used for Chrome trace format compatibility. */
const TRACE_PID = 1;
const TRACE_TID = 1;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ProfilerInternalState {
  enabled: boolean;
  /** Circular buffer for completed spans. */
  spans: ProfileSpan[];
  spanIndex: number;
  spanCount: number;
  readonly maxSpans: number;
  /** Active (open) spans keyed by a scope token. */
  activeSpans: Map<
    symbol,
    { name: string; cat: string; startMs: number; args?: Readonly<Record<string, string | number | boolean>> }
  >;
  /** Counter samples. */
  counters: CounterSample[];
  counterIndex: number;
  counterCount: number;
  readonly maxCounters: number;
  /** Wall-clock reference point for relative timestamps. */
  readonly originMs: number;
}

const stateMap = new Map<symbol, ProfilerInternalState>();

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

/**
 * Opaque handle returned by {@link createProfiler}.
 * Pass to every profiling function.
 */
export interface ProfilerHandle {
  readonly id: symbol;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Options for {@link createProfiler}.
 */
export interface ProfilerOptions {
  /**
   * Whether profiling is active.
   * When false all calls are no-ops and no allocations occur.
   * Default: true.
   */
  readonly enabled?: boolean;
  /**
   * Maximum number of completed spans to retain in the circular buffer.
   * Older spans are overwritten when the buffer is full.
   * Default: 10 000.
   */
  readonly maxSpans?: number;
  /**
   * Maximum number of counter samples to retain.
   * Default: 5 000.
   */
  readonly maxCounters?: number;
}

/**
 * Creates a new profiler instance.
 *
 * @example
 * ```ts
 * const profiler = createProfiler({ enabled: true });
 *
 * const token = beginSpan(profiler, 'renderFrame', 'render');
 * // ... do work ...
 * endSpan(profiler, token);
 *
 * console.log(getSnapshot(profiler).stats);
 * ```
 */
export function createProfiler(options: ProfilerOptions = {}): ProfilerHandle {
  const id = Symbol('PerformanceProfiler');
  const { enabled = true, maxSpans = DEFAULT_MAX_SPANS, maxCounters = DEFAULT_MAX_COUNTERS } = options;

  stateMap.set(id, {
    enabled,
    spans: new Array<ProfileSpan>(maxSpans),
    spanIndex: 0,
    spanCount: 0,
    maxSpans,
    activeSpans: new Map(),
    counters: new Array<CounterSample>(maxCounters),
    counterIndex: 0,
    counterCount: 0,
    maxCounters,
    originMs: performance.now(),
  });

  return { id };
}

/**
 * Destroys the profiler and frees internal state.
 */
export function destroyProfiler(handle: ProfilerHandle): void {
  stateMap.delete(handle.id);
}

// ---------------------------------------------------------------------------
// Span recording
// ---------------------------------------------------------------------------

/**
 * Opens a span and returns an opaque scope token.
 * Call {@link endSpan} with the token to close the span.
 *
 * @returns Scope token — pass to {@link endSpan}.
 */
export function beginSpan(
  handle: ProfilerHandle,
  name: string,
  cat: string,
  args?: Readonly<Record<string, string | number | boolean>>
): symbol {
  const token = Symbol(name);
  const state = stateMap.get(handle.id);
  if (!state || !state.enabled) return token;

  state.activeSpans.set(token, { name, cat, startMs: performance.now(), args });
  return token;
}

/**
 * Closes an open span identified by its scope token.
 * Silently ignores unknown / already-closed tokens.
 */
export function endSpan(handle: ProfilerHandle, token: symbol): void {
  const state = stateMap.get(handle.id);
  if (!state || !state.enabled) return;

  const open = state.activeSpans.get(token);
  if (!open) return;

  state.activeSpans.delete(token);

  const endMs = performance.now();
  const span: ProfileSpan = {
    name: open.name,
    cat: open.cat,
    startMs: open.startMs,
    endMs,
    durationMs: endMs - open.startMs,
    args: open.args,
  };

  // Write into circular buffer
  state.spans[state.spanIndex] = span;
  state.spanIndex = (state.spanIndex + 1) % state.maxSpans;
  if (state.spanCount < state.maxSpans) state.spanCount++;
}

/**
 * Records a complete span in a single call (no open/close token required).
 *
 * @example
 * ```ts
 * const t0 = performance.now();
 * doWork();
 * recordSpan(profiler, 'doWork', 'render', t0, performance.now());
 * ```
 */
export function recordSpan(
  handle: ProfilerHandle,
  name: string,
  cat: string,
  startMs: number,
  endMs: number,
  args?: Readonly<Record<string, string | number | boolean>>
): void {
  const state = stateMap.get(handle.id);
  if (!state || !state.enabled) return;

  const span: ProfileSpan = {
    name,
    cat,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    args,
  };

  state.spans[state.spanIndex] = span;
  state.spanIndex = (state.spanIndex + 1) % state.maxSpans;
  if (state.spanCount < state.maxSpans) state.spanCount++;
}

/**
 * Measures a synchronous function and records a span around it.
 *
 * @example
 * ```ts
 * const result = measure(profiler, 'computeLayout', 'render', () => computeLayout(data));
 * ```
 */
export function measure<T>(
  handle: ProfilerHandle,
  name: string,
  cat: string,
  fn: () => T,
  args?: Readonly<Record<string, string | number | boolean>>
): T {
  const token = beginSpan(handle, name, cat, args);
  try {
    return fn();
  } finally {
    endSpan(handle, token);
  }
}

/**
 * Measures an async function and records a span around it.
 *
 * @example
 * ```ts
 * const buffer = await measureAsync(profiler, 'gpuMapRead', 'gpu', () => buffer.mapAsync(GPUMapMode.READ));
 * ```
 */
export async function measureAsync<T>(
  handle: ProfilerHandle,
  name: string,
  cat: string,
  fn: () => Promise<T>,
  args?: Readonly<Record<string, string | number | boolean>>
): Promise<T> {
  const token = beginSpan(handle, name, cat, args);
  try {
    return await fn();
  } finally {
    endSpan(handle, token);
  }
}

// ---------------------------------------------------------------------------
// Counter recording
// ---------------------------------------------------------------------------

/**
 * Records a counter sample (a named scalar value at a point in time).
 * Useful for tracking GPU buffer sizes, active series counts, etc.
 *
 * @example
 * ```ts
 * recordCounter(profiler, 'gpuBufferBytes', totalGPUBytes);
 * ```
 */
export function recordCounter(handle: ProfilerHandle, name: string, value: number): void {
  const state = stateMap.get(handle.id);
  if (!state || !state.enabled) return;

  const sample: CounterSample = { name, timeMs: performance.now(), value };
  state.counters[state.counterIndex] = sample;
  state.counterIndex = (state.counterIndex + 1) % state.maxCounters;
  if (state.counterCount < state.maxCounters) state.counterCount++;
}

// ---------------------------------------------------------------------------
// Snapshots and statistics
// ---------------------------------------------------------------------------

/**
 * Computes aggregated statistics for all completed spans grouped by name+category.
 */
function computeStats(spans: readonly ProfileSpan[]): SpanStats[] {
  const groups = new Map<string, number[]>();

  for (const span of spans) {
    const key = `${span.cat}::${span.name}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(span.durationMs);
  }

  const stats: SpanStats[] = [];

  for (const [key, durations] of groups) {
    const colonIdx = key.indexOf('::');
    const cat = key.slice(0, colonIdx);
    const name = key.slice(colonIdx + 2);

    durations.sort((a, b) => a - b);

    const count = durations.length;
    let total = 0;
    for (const d of durations) total += d;
    const avg = total / count;
    const min = durations[0];
    const max = durations[count - 1];
    const p50 = durations[Math.floor(count * 0.5)];
    const p95 = durations[Math.floor(count * 0.95)];
    const p99 = durations[Math.floor(count * 0.99)];

    stats.push({
      name,
      cat,
      count,
      totalMs: total,
      minMs: min,
      maxMs: max,
      avgMs: avg,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
    });
  }

  stats.sort((a, b) => b.totalMs - a.totalMs);
  return stats;
}

/** Extracts the live spans from the circular buffer in chronological order. */
function extractSpans(state: ProfilerInternalState): ProfileSpan[] {
  const count = state.spanCount;
  if (count === 0) return [];

  const { spans, spanIndex, maxSpans } = state;
  const result: ProfileSpan[] = new Array(count);

  if (count < maxSpans) {
    // Buffer not full yet — elements are at indices 0..count-1
    for (let i = 0; i < count; i++) result[i] = spans[i];
  } else {
    // Buffer full — oldest element is at spanIndex
    for (let i = 0; i < count; i++) {
      result[i] = spans[(spanIndex + i) % maxSpans];
    }
  }

  return result;
}

/** Extracts counter samples from the circular buffer in chronological order. */
function extractCounters(state: ProfilerInternalState): CounterSample[] {
  const count = state.counterCount;
  if (count === 0) return [];

  const { counters, counterIndex, maxCounters } = state;
  const result: CounterSample[] = new Array(count);

  if (count < maxCounters) {
    for (let i = 0; i < count; i++) result[i] = counters[i];
  } else {
    for (let i = 0; i < count; i++) {
      result[i] = counters[(counterIndex + i) % maxCounters];
    }
  }

  return result;
}

/**
 * Returns an immutable snapshot of all recorded data including aggregated statistics.
 */
export function getSnapshot(handle: ProfilerHandle): ProfilerSnapshot {
  const state = stateMap.get(handle.id);
  if (!state) {
    return { spans: [], counters: [], stats: [], capturedAt: performance.now() };
  }

  const spans = extractSpans(state);
  const counters = extractCounters(state);
  const stats = computeStats(spans);

  return { spans, counters, stats, capturedAt: performance.now() };
}

/**
 * Clears all recorded spans and counters without destroying the profiler.
 */
export function clearProfiler(handle: ProfilerHandle): void {
  const state = stateMap.get(handle.id);
  if (!state) return;

  state.spanIndex = 0;
  state.spanCount = 0;
  state.counterIndex = 0;
  state.counterCount = 0;
  state.activeSpans.clear();
}

// ---------------------------------------------------------------------------
// Trace export (Chrome DevTools format)
// ---------------------------------------------------------------------------

/**
 * Exports all recorded spans as a Chrome DevTools Trace Event Format JSON object.
 *
 * The returned object can be serialised with `JSON.stringify` and loaded into
 * chrome://tracing or Perfetto UI for flame-graph visualisation.
 *
 * @example
 * ```ts
 * const trace = exportTrace(profiler);
 * const json = JSON.stringify(trace, null, 2);
 * // Save to file or copy to clipboard for chrome://tracing
 * ```
 */
export function exportTrace(handle: ProfilerHandle, metadata?: Readonly<Record<string, string | number>>): TraceExport {
  const state = stateMap.get(handle.id);
  if (!state) return { traceEvents: [] };

  const spans = extractSpans(state);
  const originMs = state.originMs;

  const traceEvents: TraceEvent[] = spans.map((span) => ({
    name: span.name,
    cat: span.cat,
    ph: 'X' as const,
    // Chrome trace format uses microseconds
    ts: (span.startMs - originMs) * 1000,
    dur: span.durationMs * 1000,
    pid: TRACE_PID,
    tid: TRACE_TID,
    args: span.args,
  }));

  // Add counter events
  const counters = extractCounters(state);
  for (const sample of counters) {
    traceEvents.push({
      name: sample.name,
      cat: 'counter',
      ph: 'C' as const,
      ts: (sample.timeMs - originMs) * 1000,
      pid: TRACE_PID,
      tid: TRACE_TID,
      args: { [sample.name]: sample.value },
    });
  }

  // Sort by timestamp for well-formed output
  traceEvents.sort((a, b) => a.ts - b.ts);

  return { traceEvents, metadata };
}

/**
 * Serialises the trace to a JSON string ready for saving to disk or clipboard.
 * Load the resulting file in chrome://tracing or https://ui.perfetto.dev.
 */
export function exportTraceJSON(handle: ProfilerHandle, metadata?: Readonly<Record<string, string | number>>): string {
  return JSON.stringify(exportTrace(handle, metadata), null, 2);
}
