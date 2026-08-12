/**
 * Render coordinator composition root (shell).
 *
 * Implementation: `./renderCoordinator/createRenderCoordinatorImpl.ts`
 * Pure policy helpers: `./renderCoordinator/data/{canRangedAppendLine,resolveSeriesDisplayData,resolveLinePackingXOffset}.ts`
 * Domain modules: `./renderCoordinator/{data,render,gpu,zoom,utils,...}`
 *
 * @module createRenderCoordinator
 */

export {
  createRenderCoordinator,
  type RenderCoordinator,
  type RenderCoordinatorCallbacks,
  type GPUContextLike,
} from './renderCoordinator/createRenderCoordinatorImpl';
