/**
 * Profiling types for ChartGPU performance instrumentation.
 *
 * Span timing follows the Chrome DevTools Trace Event Format so recordings
 * can be imported directly into chrome://tracing or Perfetto UI.
 *
 * @see https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 */

/** High-resolution timestamp in microseconds (matches Chrome trace format). */
export type Microseconds = number & { readonly __brand: 'Microseconds' };

/** Phase identifiers used by the Chrome Trace Event Format. */
export type TracePhase =
  | 'B' // Begin
  | 'E' // End
  | 'X' // Complete (begin+end in one event)
  | 'i' // Instant
  | 'C'; // Counter

/** A single recorded profiling span. */
export interface ProfileSpan {
  /** Display name of the span. */
  readonly name: string;
  /** Category (e.g. "render", "gpu", "data", "interaction"). */
  readonly cat: string;
  /** Start time in milliseconds from profiler start (performance.now()). */
  readonly startMs: number;
  /** End time in milliseconds from profiler start (performance.now()). */
  readonly endMs: number;
  /** Duration in milliseconds. */
  readonly durationMs: number;
  /** Arbitrary key-value metadata attached to the span. */
  readonly args?: Readonly<Record<string, string | number | boolean>>;
}

/** A counter snapshot for a named metric over time. */
export interface CounterSample {
  /** Counter name (e.g. "gpuBufferBytes", "activeSeries"). */
  readonly name: string;
  /** Wall-clock time of the sample (ms from profiler start). */
  readonly timeMs: number;
  /** Sampled value at that point in time. */
  readonly value: number;
}

/** Aggregated statistics for all spans sharing the same name+category. */
export interface SpanStats {
  readonly name: string;
  readonly cat: string;
  readonly count: number;
  readonly totalMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

/**
 * Chrome DevTools Trace Event Format event object.
 * Suitable for JSON serialisation and import into chrome://tracing.
 */
export interface TraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ph: TracePhase;
  /** Timestamp in microseconds. */
  readonly ts: number;
  /** Duration in microseconds (only present for ph='X'). */
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly args?: Readonly<Record<string, string | number | boolean>>;
}

/** Full trace object for export. */
export interface TraceExport {
  readonly traceEvents: readonly TraceEvent[];
  readonly metadata?: Readonly<Record<string, string | number>>;
}

/** Immutable snapshot of all recorded profiling data at a given moment. */
export interface ProfilerSnapshot {
  readonly spans: readonly ProfileSpan[];
  readonly counters: readonly CounterSample[];
  readonly stats: readonly SpanStats[];
  /** Wall-clock time when the snapshot was taken (ms). */
  readonly capturedAt: number;
}
