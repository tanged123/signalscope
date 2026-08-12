import type { ThemeConfig } from './types';
import { darkTheme } from './darkTheme';
import { lightTheme } from './lightTheme';

export { darkTheme, lightTheme };
export type { ThemeConfig };

export type ThemeName = 'dark' | 'light';

export function getTheme(name: ThemeName): ThemeConfig {
  return name === 'dark' ? darkTheme : lightTheme;
}
