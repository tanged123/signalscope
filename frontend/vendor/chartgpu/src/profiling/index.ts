/**
 * ChartGPU Profiling module
 *
 * Provides lightweight performance profiling infrastructure:
 *
 * - Span-based timing with begin/end tokens
 * - Synchronous and async `measure` helpers
 * - Counter time-series for tracking scalar metrics over time
 * - Snapshot export for aggregated statistics
 * - Chrome DevTools Trace Event Format export for flame-graph visualisation
 *   in chrome://tracing or https://ui.perfetto.dev
 */

export type {
  CounterSample,
  ProfileSpan,
  ProfilerSnapshot,
  SpanStats,
  TraceEvent,
  TraceExport,
  TracePhase,
  Microseconds,
} from './types';

export type { ProfilerHandle, ProfilerOptions } from './PerformanceProfiler';

export {
  createProfiler,
  destroyProfiler,
  beginSpan,
  endSpan,
  recordSpan,
  measure,
  measureAsync,
  recordCounter,
  getSnapshot,
  clearProfiler,
  exportTrace,
  exportTraceJSON,
} from './PerformanceProfiler';
