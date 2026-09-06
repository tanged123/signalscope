import { axisControlsMarkup } from "./panel-axes";
import { DEFAULT_PANEL_LINE_WIDTH } from "../app/style-defaults";

export function lineToolbarMarkup(): string {
  return `<span class="panel-toolbar-group panel-toolbar-axes">
        <button class="panel-action panel-axis-toggle" title="Switch axis presentation">axes: gutter</button>
        ${axisControlsMarkup()}</span>
      <span class="panel-toolbar-group" role="group" aria-label="Plot appearance">
        <button class="panel-toolbar-control panel-line-width" type="button" title="Panel line-width default" aria-label="Line width"><span class="line-width-sample" aria-hidden="true"></span><span class="panel-line-width-value">${DEFAULT_PANEL_LINE_WIDTH.toFixed(1)}</span> <span class="toolbar-caret">▾</span></button>
        <button class="panel-toolbar-control panel-ghost-opacity" type="button" title="Dim non-selected series">dim <b class="panel-ghost-value">none</b> <span class="toolbar-caret">▾</span></button>
      </span>
      <span class="panel-toolbar-group" role="group" aria-label="Plot readouts">
        <button class="panel-toolbar-control panel-legend-state" type="button" title="Legend type">legend <b class="panel-legend-value">keys</b> <span class="toolbar-caret">▾</span></button>
        <button class="panel-action panel-stats-toggle" title="Toggle statistics columns (S)" aria-pressed="false">Σ <span>stats</span></button>
        <button class="panel-toolbar-control panel-tips" type="button" title="Tip density and actions">tips <b class="panel-tips-value">0</b> <span class="toolbar-caret">▾</span></button>
      </span>`;
}
