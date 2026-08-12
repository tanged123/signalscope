/**
 * Theme configuration types (Phase 2.5).
 */

export interface ThemeConfig {
  readonly backgroundColor: string;
  readonly textColor: string;
  readonly axisLineColor: string;
  readonly axisTickColor: string;
  readonly gridLineColor: string;
  readonly colorPalette: string[];
  readonly fontFamily: string;
  readonly fontSize: number;
}
