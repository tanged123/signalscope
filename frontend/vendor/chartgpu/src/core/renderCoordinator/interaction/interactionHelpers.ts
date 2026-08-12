/**
 * Interaction helper utilities for pointer tracking and interaction X management.
 *
 * Provides pure functions for transforming pointer states, managing interaction X
 * in domain coordinates, and computing effective pointer positions for crosshair
 * and tooltip rendering.
 *
 * @module interactionHelpers
 */

import type { LinearScale } from '../../../utils/scales';

/**
 * Source of pointer events - either real mouse input or externally synchronized.
 */
type PointerSource = 'mouse' | 'sync';

/**
 * Pointer state tracking both canvas-local CSS pixels and plot-relative grid coordinates.
 */
export interface PointerState {
  /** Source of the pointer event */
  readonly source: PointerSource;
  /** X position in canvas-local CSS pixels */
  readonly x: number;
  /** Y position in canvas-local CSS pixels */
  readonly y: number;
  /** X position in plot-relative grid CSS pixels */
  readonly gridX: number;
  /** Y position in plot-relative grid CSS pixels */
  readonly gridY: number;
  /** Whether the pointer is inside the plot grid */
  readonly isInGrid: boolean;
  /** Whether a pointer event has occurred */
  readonly hasPointer: boolean;
}

/**
 * Interaction scales for coordinate transformations between domain and grid space.
 */
interface InteractionScales {
  readonly xScale: LinearScale;
  readonly yScale: LinearScale;
  readonly plotWidthCss: number;
  readonly plotHeightCss: number;
}

/**
 * Grid area boundaries in CSS pixels.
 */
interface GridArea {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Creates an initial empty pointer state.
 *
 * @returns Pointer state with no active pointer
 */
export function createPointerState(): PointerState {
  return {
    source: 'mouse',
    x: 0,
    y: 0,
    gridX: 0,
    gridY: 0,
    isInGrid: false,
    hasPointer: false,
  };
}

/**
 * Updates pointer state from mouse move event payload.
 *
 * @param x - Canvas-local CSS pixel X
 * @param y - Canvas-local CSS pixel Y
 * @param gridX - Plot-relative grid CSS pixel X
 * @param gridY - Plot-relative grid CSS pixel Y
 * @param isInGrid - Whether pointer is inside plot grid
 * @returns Updated pointer state with source 'mouse'
 */
export function updatePointerFromMouse(
  x: number,
  y: number,
  gridX: number,
  gridY: number,
  isInGrid: boolean
): PointerState {
  return {
    source: 'mouse',
    x,
    y,
    gridX,
    gridY,
    isInGrid,
    hasPointer: true,
  };
}

/**
 * Clears pointer state when mouse leaves canvas.
 *
 * Preserves source and coordinates but marks as not active.
 *
 * @param prevState - Previous pointer state
 * @returns Updated pointer state with hasPointer=false
 */
export function clearPointer(prevState: PointerState): PointerState {
  return {
    ...prevState,
    isInGrid: false,
    hasPointer: false,
  };
}

/**
 * Converts domain X coordinate to grid CSS pixel coordinate.
 *
 * @param interactionX - X coordinate in domain units
 * @param xScale - Linear scale for X axis
 * @returns Grid X in CSS pixels, or null if conversion fails
 */
function domainToGridX(interactionX: number, xScale: LinearScale): number | null {
  const gridX = xScale.scale(interactionX);
  return Number.isFinite(gridX) ? gridX : null;
}

/**
 * Converts grid CSS pixel coordinate to domain X coordinate.
 *
 * @param gridX - X coordinate in grid CSS pixels
 * @param xScale - Linear scale for X axis
 * @returns Domain X, or null if conversion fails
 */
export function gridToDomainX(gridX: number, xScale: LinearScale): number | null {
  const domainX = xScale.invert(gridX);
  return Number.isFinite(domainX) ? domainX : null;
}

/**
 * Computes effective pointer state for sync mode.
 *
 * When interaction is driven by external synchronization (not mouse), derives
 * a synthetic pointer position from the interaction X in domain units. Y is
 * arbitrary (midpoint) since sync mode only tracks X.
 *
 * Returns null if interactionX is null or coordinate conversion fails.
 *
 * @param interactionX - X coordinate in domain units (or null if inactive)
 * @param scales - Interaction scales for coordinate transformations
 * @param gridArea - Grid area boundaries for canvas-local coordinate calculation
 * @returns Effective pointer state, or null if sync mode is inactive
 */
function computeSyncPointer(
  interactionX: number | null,
  scales: InteractionScales,
  gridArea: GridArea
): PointerState | null {
  if (interactionX === null) {
    return null;
  }

  const gridX = domainToGridX(interactionX, scales.xScale);
  if (gridX === null) {
    return null;
  }

  // Arbitrary Y at midpoint (sync mode doesn't track Y)
  const gridY = scales.plotHeightCss * 0.5;

  // Check if the synthetic position is within grid bounds
  const isInGrid = gridX >= 0 && gridX <= scales.plotWidthCss && gridY >= 0 && gridY <= scales.plotHeightCss;

  return {
    source: 'sync',
    gridX,
    gridY,
    // Canvas-local CSS pixels (grid-relative + grid offset)
    x: gridArea.left + gridX,
    y: gridArea.top + gridY,
    isInGrid,
    hasPointer: isInGrid,
  };
}

/**
 * Resolves effective pointer state based on source mode.
 *
 * - Mouse mode: use the provided pointer state as-is
 * - Sync mode: compute synthetic pointer from interaction X
 *
 * This enables unified rendering logic for both mouse-driven and externally
 * synchronized interactions (e.g., chart sync).
 *
 * @param pointerState - Current pointer state
 * @param interactionX - X coordinate in domain units (for sync mode)
 * @param scales - Interaction scales for coordinate transformations
 * @param gridArea - Grid area boundaries
 * @returns Effective pointer state for rendering
 */
export function computeEffectivePointer(
  pointerState: PointerState,
  interactionX: number | null,
  scales: InteractionScales | null,
  gridArea: GridArea
): PointerState {
  if (pointerState.source === 'mouse') {
    return pointerState;
  }

  // Sync mode: derive pointer from interaction X
  if (!scales) {
    return { ...pointerState, hasPointer: false, isInGrid: false };
  }

  const syncPointer = computeSyncPointer(interactionX, scales, gridArea);
  if (!syncPointer) {
    return { ...pointerState, hasPointer: false, isInGrid: false };
  }

  return syncPointer;
}

/**
 * Normalizes interaction X value.
 *
 * Returns null for null, NaN, or Infinity values. This ensures consistent
 * null-checking throughout the interaction system.
 *
 * @param x - Interaction X value to normalize
 * @returns Normalized value or null
 */
export function normalizeInteractionX(x: number | null): number | null {
  return x !== null && Number.isFinite(x) ? x : null;
}

/**
 * Creates a listener management system for interaction X changes.
 *
 * Returns utilities for adding, removing, and notifying listeners.
 *
 * @returns Listener management utilities
 */
export function createInteractionXListeners(): {
  add: (callback: (x: number | null, source?: unknown) => void) => void;
  remove: (callback: (x: number | null, source?: unknown) => void) => void;
  emit: (x: number | null, source?: unknown) => void;
  clear: () => void;
} {
  const listeners = new Set<(x: number | null, source?: unknown) => void>();

  return {
    add: (callback) => {
      listeners.add(callback);
    },
    remove: (callback) => {
      listeners.delete(callback);
    },
    emit: (x, source) => {
      const snapshot = Array.from(listeners);
      for (const cb of snapshot) {
        cb(x, source);
      }
    },
    clear: () => {
      listeners.clear();
    },
  };
}

/**
 * Determines if interaction X should be updated based on value equality.
 *
 * Prevents redundant updates when the value and source haven't changed.
 *
 * @param current - Current interaction X value
 * @param currentSource - Current source identifier
 * @param next - New interaction X value
 * @param nextSource - New source identifier
 * @returns True if update is needed
 */
export function shouldUpdateInteractionX(
  current: number | null,
  currentSource: unknown,
  next: number | null,
  nextSource: unknown
): boolean {
  return current !== next || currentSource !== nextSource;
}
