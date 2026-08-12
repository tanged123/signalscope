/**
 * Data point type guards and utilities for the RenderCoordinator.
 *
 * These pure functions handle the dual data format system (tuple vs object)
 * and provide type-safe access to point coordinates.
 *
 * @module dataPointUtils
 */

import type { DataPoint, DataPointTuple, OHLCDataPoint, OHLCDataPointTuple } from '../../../config/types';

/**
 * Validates that a number is finite, returning the number or null.
 *
 * @param v - Value to validate
 * @returns The number if finite, otherwise null
 */
export const finiteOrNull = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Validates that a number is finite, returning the number or undefined.
 *
 * @param v - Value to validate
 * @returns The number if finite, otherwise undefined
 */
export const finiteOrUndefined = (v: number | undefined): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Compile-time exhaustiveness check for error handling.
 * Used in switch statements to ensure all cases are handled.
 *
 * @param value - The value that should be of type `never` if all cases are handled
 * @throws Always throws an error if called
 */
export const assertUnreachable = (value: never): never => {
  // Intentionally minimal message: this is used for compile-time exhaustiveness.
  throw new Error(`RenderCoordinator: unreachable value: ${String(value)}`);
};

/**
 * Type guard: checks if a DataPoint is in tuple form `[x, y]`.
 *
 * @param p - The data point to check
 * @returns True if the point is a tuple, false if it's an object
 */
export const isTupleDataPoint = (p: DataPoint): p is DataPointTuple => Array.isArray(p);

/**
 * Extracts x,y coordinates from either tuple or object point format.
 *
 * @param p - The data point (either tuple or object format)
 * @returns Object with x and y properties
 */
export const getPointXY = (p: DataPoint): { readonly x: number; readonly y: number } => {
  if (isTupleDataPoint(p)) return { x: p[0], y: p[1] };
  return { x: p.x, y: p.y };
};

/**
 * Type guard: checks if a data point is in tuple OHLC form `[timestamp, open, high, low, close]`.
 *
 * @param p - The OHLC data point to check
 * @returns True if the point is a tuple, false if it's an object
 */
export const isTupleOHLCDataPoint = (p: OHLCDataPoint): p is OHLCDataPointTuple => Array.isArray(p);
