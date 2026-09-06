import { basename } from "./dom";

export function sessionDisplayTitle(
  title: string | null,
  path: string | null,
): string {
  return title ?? (path === null ? "Untitled" : basename(path));
}

export function renderSessionTitle(
  button: HTMLButtonElement,
  name: string,
  dirty: boolean,
): void {
  button.textContent = dirty ? `${name} •` : name;
  button.title = `Rename session: ${name}`;
}

export function bindSessionTitle(
  button: HTMLButtonElement,
  read: () => string,
  commit: (title: string) => void,
): void {
  button.addEventListener("click", () => {
    if (button.hidden) return;
    const input = document.createElement("input");
    input.className = "session-title-input";
    input.setAttribute("aria-label", "Session name");
    input.value = read();
    input.spellcheck = false;
    button.hidden = true;
    button.after(input);
    let finished = false;
    const finish = (save: boolean, focus: boolean): void => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      input.remove();
      button.hidden = false;
      if (save && name.length > 0 && name !== read()) commit(name);
      if (focus) button.focus();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        finish(event.key === "Enter", true);
      }
    });
    input.addEventListener("blur", () => finish(true, false));
    input.focus();
    input.select();
  });
}
