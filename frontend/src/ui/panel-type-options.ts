/** Shared type names, descriptions, and icons for creation and empty panels. */
export function panelTypeOptions(): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = `
  <button type="button" data-type="line2d">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4v16h18M5 14l4-5 4 7 4-9 4 4"/></svg>
    <span><strong>Time series</strong><small>Signals over time</small></span>
  </button>
  <button type="button" data-type="scatter2d">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4v16h18"/><circle cx="8" cy="14" r="1"/><circle cx="12" cy="9" r="1"/><circle cx="15" cy="13" r="1"/><circle cx="19" cy="6" r="1"/></svg>
    <span><strong>Scatter</strong><small>One signal against another</small></span>
  </button>`;
  return template.content;
}
