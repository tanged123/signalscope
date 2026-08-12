export type Rgba01 = readonly [r: number, g: number, b: number, a: number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clamp255 = (v: number): number => Math.min(255, Math.max(0, v));

const parseHexNibble = (hex: string): number => {
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
};

const parseHexByte = (hex: string): number => {
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0;
};

const parseHexColorToRgba01 = (color: string): Rgba01 | null => {
  const c = color.trim();
  if (!c.startsWith('#')) return null;

  const hex = c.slice(1);

  // #rgb
  if (hex.length === 3) {
    const r = parseHexNibble(hex[0]);
    const g = parseHexNibble(hex[1]);
    const b = parseHexNibble(hex[2]);
    return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255, 1];
  }

  // #rgba
  if (hex.length === 4) {
    const r = parseHexNibble(hex[0]);
    const g = parseHexNibble(hex[1]);
    const b = parseHexNibble(hex[2]);
    const a = parseHexNibble(hex[3]);
    return [(r * 17) / 255, (g * 17) / 255, (b * 17) / 255, (a * 17) / 255];
  }

  // #rrggbb
  if (hex.length === 6) {
    const r = parseHexByte(hex.slice(0, 2));
    const g = parseHexByte(hex.slice(2, 4));
    const b = parseHexByte(hex.slice(4, 6));
    return [r / 255, g / 255, b / 255, 1];
  }

  // #rrggbbaa
  if (hex.length === 8) {
    const r = parseHexByte(hex.slice(0, 2));
    const g = parseHexByte(hex.slice(2, 4));
    const b = parseHexByte(hex.slice(4, 6));
    const a = parseHexByte(hex.slice(6, 8));
    return [r / 255, g / 255, b / 255, a / 255];
  }

  return null;
};

const parseRgbNumberOrPercent = (token: string): number | null => {
  const t = token.trim();
  if (t.length === 0) return null;

  if (t.endsWith('%')) {
    const n = Number.parseFloat(t.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return clamp255((n / 100) * 255);
  }

  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return clamp255(n);
};

const parseAlphaNumberOrPercent = (token: string): number | null => {
  const t = token.trim();
  if (t.length === 0) return null;

  if (t.endsWith('%')) {
    const n = Number.parseFloat(t.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return clamp01(n / 100);
  }

  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return clamp01(n);
};

const parseRgbFuncToRgba01 = (color: string): Rgba01 | null => {
  const c = color.trim();
  const m = /^(rgba?|RGBA?)\(\s*([^\)]*)\s*\)$/.exec(c);
  if (!m) return null;

  const fn = m[1].toLowerCase();
  const argsRaw = m[2];

  // Requirement scope: support comma-separated rgb()/rgba().
  // (We intentionally do not attempt full CSS Color 4 space-separated syntax here.)
  const parts = argsRaw.split(',').map((p) => p.trim());
  if (fn === 'rgb') {
    if (parts.length !== 3) return null;
    const r = parseRgbNumberOrPercent(parts[0]);
    const g = parseRgbNumberOrPercent(parts[1]);
    const b = parseRgbNumberOrPercent(parts[2]);
    if (r == null || g == null || b == null) return null;
    return [r / 255, g / 255, b / 255, 1];
  }

  if (fn === 'rgba') {
    if (parts.length !== 4) return null;
    const r = parseRgbNumberOrPercent(parts[0]);
    const g = parseRgbNumberOrPercent(parts[1]);
    const b = parseRgbNumberOrPercent(parts[2]);
    const a = parseAlphaNumberOrPercent(parts[3]);
    if (r == null || g == null || b == null || a == null) return null;
    return [r / 255, g / 255, b / 255, a];
  }

  return null;
};

/**
 * Parse a CSS color string into RGBA floats in [0..1].
 *
 * Supported:
 * - #rgb / #rgba / #rrggbb / #rrggbbaa
 * - rgb(r,g,b)
 * - rgba(r,g,b,a)
 *
 * Returns null when parsing fails.
 */
export const parseCssColorToRgba01 = (color: string): Rgba01 | null => {
  if (typeof color !== 'string') return null;
  const c = color.trim();
  if (c.length === 0) return null;

  const hex = parseHexColorToRgba01(c);
  if (hex) return hex;

  const rgb = parseRgbFuncToRgba01(c);
  if (rgb) return rgb;

  return null;
};

export const parseCssColorToGPUColor = (color: string, fallback: GPUColor = { r: 0, g: 0, b: 0, a: 1 }): GPUColor => {
  const rgba = parseCssColorToRgba01(color);
  if (!rgba) return fallback;
  const [r, g, b, a] = rgba;
  return { r, g, b, a };
};
