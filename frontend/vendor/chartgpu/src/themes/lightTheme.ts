import type { ThemeConfig } from './types';

const palette = ['#1F77B4', '#FF7F0E', '#2CA02C', '#D62728', '#9467BD', '#8C564B', '#E377C2', '#17BECF'] as const;

export const lightTheme = {
  backgroundColor: '#ffffff',
  textColor: '#333333',
  axisLineColor: 'rgba(0,0,0,0.35)',
  axisTickColor: 'rgba(0,0,0,0.55)',
  gridLineColor: 'rgba(0,0,0,0.1)',
  colorPalette: [...palette],
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  fontSize: 12,
} satisfies ThemeConfig;
