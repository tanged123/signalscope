export function required<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing application element: ${selector}`);
  }
  return element;
}

/** The final segment of a native or POSIX path, for display labels. */
export function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/**
 * A signal's short display name: the last two path segments, which keeps the
 * group that disambiguates same-named signals without the full path.
 */
export function signalLabel(path: string): string {
  return path.split("/").slice(-2).join("/");
}

/**
 * Pointer-capture drag scaffold: on pointerdown, captures the pointer and
 * calls `begin` for per-drag state; its `onMove`/`onEnd` run until
 * pointerup or pointercancel, then listeners detach.
 */
export function bindPointerDrag(
  element: HTMLElement,
  begin: (down: PointerEvent) => {
    onMove: (move: PointerEvent) => void;
    onEnd?: () => void;
  },
): void {
  element.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    element.setPointerCapture(down.pointerId);
    const drag = begin(down);
    const move = (event: PointerEvent): void => {
      drag.onMove(event);
    };
    const finish = (): void => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", finish);
      drag.onEnd?.();
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
  });
}
