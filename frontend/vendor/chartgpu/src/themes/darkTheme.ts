import type { ThemeConfig } from './types';

const palette = ['#00E5FF', '#FF2D95', '#B026FF', '#00F5A0', '#FFD300', '#FF6B00', '#4D5BFF', '#FF3D3D'] as const;

export const darkTheme = {
  backgroundColor: '#1a1a2e',
  textColor: '#e0e0e0',
  axisLineColor: 'rgba(224,224,224,0.35)',
  axisTickColor: 'rgba(224,224,224,0.55)',
  gridLineColor: 'rgba(255,255,255,0.1)',
  colorPalette: [...palette],
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  fontSize: 12,
} satisfies ThemeConfig;
