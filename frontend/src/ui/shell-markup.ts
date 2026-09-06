import { formulaBarMarkup } from "./formula-bar";
import { performanceMarkup } from "./shell-status";

export function shellMarkup(): string {
  return `<main class="workbench formula-collapsed">
    <div class="title-bar">
      <button class="menu-button" aria-label="Application menu" aria-haspopup="menu" aria-expanded="false">≡</button>
      <span class="brand">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11 4 5l3 8 3-10 2 6 2-2" fill="none" stroke="var(--amber-7)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        SIGNALSCOPE
      </span>
      <button class="workspace-name" type="button" title="Rename session" aria-label="Rename session">Untitled</button>
    </div>
    <div class="gpu-warning" hidden role="status">
      <span class="gpu-warning-message">WebGPU unavailable — time-series panels disabled</span>
      <button class="gpu-warning-dismiss" type="button" aria-label="Dismiss WebGPU warning">✕</button>
      <button class="gpu-warning-reload" type="button" aria-label="Reload SignalScope" hidden>Reload</button>
    </div>

    <div class="workspace-strip">
      <nav class="workspace-tabs" aria-label="Workspace tabs" role="tablist"></nav>
    </div>

    <aside class="signal-tree" id="signal-tree" aria-label="Signals">
      <div class="search-wrap">
        <div class="search-filter-row">
          <span class="search-filter-prefix">/</span>
          <input class="signal-search" aria-label="Search signals" placeholder="Search signals…" spellcheck="false" />
        </div>
        <div class="search-count"></div>
      </div>
      <div class="tree-heading sets-heading">
        <span>SETS</span>
        <button
          class="sets-save-selection"
          type="button"
          title="Save selected signals as set"
          disabled
        >
          ★+
        </button>
      </div>
      <div class="set-name-row tree-row tree-set-draft" hidden>
        <span class="tree-set-draft-mark">★</span>
        <input class="set-name-input" placeholder="set name" spellcheck="false" aria-label="Set name" />
        <button class="set-name-save" type="button" title="Save set" aria-label="Save set">✓</button>
        <button class="set-name-cancel" type="button" title="Cancel" aria-label="Cancel">✕</button>
      </div>
      <div class="tree-sets"></div>
      <div class="tree-heading signals-heading">SIGNALS</div>
      <div class="outline-scroll"></div>
      <div class="source-footer">
        <div class="ingest-progress" hidden></div>
        <div class="dock-footer">
          <div class="dock-load-row">
            <button class="dock-add-source" type="button">+ source</button>
          </div>
        </div>
      </div>
    </aside>

    <div class="tree-resize-handle dock-resize-handle" role="separator" aria-label="Resize signal tree" aria-orientation="vertical" aria-valuemin="0" tabindex="0"></div>

    <section class="workspace" aria-label="Panel workspace"></section>

    <div class="mode-help" role="status" hidden></div>

    ${formulaBarMarkup()}
    <div class="plot-tip" hidden></div>

    <footer class="status-bar">
      <span class="dock-toggles">
        <button class="status-button active tree-toggle" title="Hide signal tree" aria-controls="signal-tree" aria-expanded="true">▤</button>
        <button class="status-button formula-toggle" title="Toggle derived formula editor (E)" aria-controls="formula-editor" aria-expanded="false"><span class="formula-symbol">ƒx</span></button>
        <button class="status-button cursor-toggle" title="Cursor mode: none — cycle (C)" aria-pressed="false">┼</button>
      </span>
      <span class="status-separator"></span>
      <span class="source-truth">
        <span class="status-aggregate">0 sources · 0 signals · 0 pts</span>
      </span>
      ${performanceMarkup()}
      <span class="status-spacer"></span>
      <span class="gesture-hint"></span>
      <span class="cursor-mode"></span>
      <span class="status-separator"></span>
      <span class="time-cluster">
        <button class="status-button active linked-toggle">⇄ linked</button>
        <span class="cursor-time">t —</span>
        <span class="window-readout"></span>
      </span>
      <span class="status-separator"></span>
      <button class="status-button help-button" type="button" title="Keyboard and gesture help (?)">? Help</button>
    </footer>
  </main>`;
}
