import { required } from "./dom";

export function showInfoDialog(
  root: HTMLElement,
  kind: "help" | "about",
  title: string,
  content: HTMLElement,
): void {
  if (root.querySelector(`.${kind}-dialog`) !== null) return;
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = `info-dialog ${kind}-dialog`;
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<header><strong></strong><button type="button" aria-label="Close ${kind}">✕</button></header>`;
  required(dialog, "strong").textContent = title;
  content.classList.add("info-content");
  dialog.append(content);
  const close = (): void => dialog.close();
  const closeButton = required<HTMLButtonElement>(dialog, "button");
  closeButton.addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      close();
  });
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Tab") {
      event.preventDefault();
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>("button, a[href]"),
      ];
      const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[
        (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
      ]?.focus();
    }
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous.closest("[hidden]") === null
      )
        previous.focus();
      else root.querySelector<HTMLElement>(".menu-button")?.focus();
    },
    { once: true },
  );
  root.append(dialog);
  dialog.showModal();
}
