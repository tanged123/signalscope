/** Owns dismissal while a native disclosure is open. */
export function bindDisclosure(details: HTMLDetailsElement): () => void {
  const summary = details.querySelector("summary");
  const close = (): void => {
    details.open = false;
  };
  const pointer = (event: PointerEvent): void => {
    if (event.target instanceof Node && !details.contains(event.target))
      close();
  };
  const key = (event: KeyboardEvent): void => {
    if (!details.open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
    summary?.focus();
  };
  const toggle = (): void => {
    if (details.open) document.addEventListener("pointerdown", pointer, true);
    else document.removeEventListener("pointerdown", pointer, true);
  };
  details.addEventListener("toggle", toggle);
  details.addEventListener("keydown", key);
  return () => {
    close();
    document.removeEventListener("pointerdown", pointer, true);
    details.removeEventListener("toggle", toggle);
    details.removeEventListener("keydown", key);
  };
}
