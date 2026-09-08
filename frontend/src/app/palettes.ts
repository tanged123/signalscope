import type {
  ColorPalette,
  ContourPalette,
  ContourStop,
  Preferences,
} from "../generated/preferences";
import data from "./contour-presets.json" with { type: "json" };
import discrete from "./discrete-presets.json" with { type: "json" };
import { upperBound } from "./binary-search";

export const COLOR_PALETTES: Record<
  Exclude<ColorPalette, "custom">,
  { label: string; colors: string[] }
> = {
  matlab: {
    label: "MATLAB",
    colors: [
      "#0072bd",
      "#d95319",
      "#edb120",
      "#7e2f8e",
      "#77ac30",
      "#4dbeee",
      "#a2142f",
    ],
  },
  tol_bright: {
    label: "Tol · Bright",
    colors: [
      "#4477aa",
      "#ee6677",
      "#228833",
      "#ccbb44",
      "#66ccee",
      "#aa3377",
      "#bbbbbb",
    ],
  },
  tol_vibrant: {
    label: "Tol · Vibrant",
    colors: [
      "#ee7733",
      "#0077bb",
      "#33bbee",
      "#ee3377",
      "#cc3311",
      "#009988",
      "#bbbbbb",
    ],
  },
  tol_contrast: {
    label: "Tol · High contrast",
    colors: ["#004488", "#ddaa33", "#bb5566"],
  },
  okabe_ito: {
    label: "Okabe–Ito",
    colors: [
      "#000000",
      "#e69f00",
      "#56b4e9",
      "#009e73",
      "#f0e442",
      "#0072b2",
      "#d55e00",
      "#cc79a7",
    ],
  },
  tableau10: { label: "Tableau · 10", colors: discrete.Tableau10 },
  brewer_dark2: { label: "ColorBrewer · Dark2", colors: discrete.Dark2 },
  brewer_set1: { label: "ColorBrewer · Set1", colors: discrete.Set1 },
  brewer_set2: { label: "ColorBrewer · Set2", colors: discrete.Set2 },
  brewer_set3: { label: "ColorBrewer · Set3", colors: discrete.Set3 },
  brewer_paired: { label: "ColorBrewer · Paired", colors: discrete.Paired },
};

export const CONTOUR_PALETTES: Record<
  Exclude<ContourPalette, "custom">,
  { label: string; stops: ContourStop[] }
> = {
  viridis: { label: "Viridis · Sequential", stops: unpack(data.viridis) },
  plasma: { label: "Plasma · Sequential", stops: unpack(data.plasma) },
  inferno: { label: "Inferno · Sequential", stops: unpack(data.inferno) },
  magma: { label: "Magma · Sequential", stops: unpack(data.magma) },
  batlow: { label: "Batlow · Sequential", stops: unpack(data.batlow) },
  vik: { label: "Vik · Diverging", stops: unpack(data.vik) },
  gray: {
    label: "Gray · Sequential",
    stops: [
      { position: 0, color: "#000000" },
      { position: 1, color: "#ffffff" },
    ],
  },
};

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function unpack(hex: string): ContourStop[] {
  const colors = hex.match(/.{6}/g) ?? [];
  return colors.map((color, index) => ({
    position: index / (colors.length - 1),
    color: "#" + color,
  }));
}

export function validColors(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.every(
      (color: unknown) => typeof color === "string" && HEX_COLOR.test(color),
    )
  );
}

export function validStops(value: unknown): value is ContourStop[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  let previous = -1;
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== "object") return false;
    const stop = item as Partial<ContourStop>;
    if (
      typeof stop.position !== "number" ||
      !Number.isFinite(stop.position) ||
      stop.position <= previous ||
      stop.position < 0 ||
      stop.position > 1 ||
      typeof stop.color !== "string" ||
      !HEX_COLOR.test(stop.color)
    )
      return false;
    previous = stop.position;
  }
  const stops = value as ContourStop[];
  return stops[0]?.position === 0 && stops.at(-1)?.position === 1;
}

export function palettePreferences(
  value: Partial<Preferences>,
): Pick<
  Preferences,
  | "color_palette"
  | "contour_palette"
  | "custom_color_palette"
  | "custom_contour_palette"
  | "contour_reversed"
> {
  return {
    color_palette:
      value.color_palette === "custom" ||
      Object.hasOwn(COLOR_PALETTES, value.color_palette ?? "")
        ? (value.color_palette as ColorPalette)
        : "matlab",
    contour_palette:
      value.contour_palette === "custom" ||
      Object.hasOwn(CONTOUR_PALETTES, value.contour_palette ?? "")
        ? (value.contour_palette as ContourPalette)
        : "viridis",
    custom_color_palette: validColors(value.custom_color_palette)
      ? value.custom_color_palette.map((color) => color.toLowerCase())
      : [...COLOR_PALETTES.matlab.colors],
    custom_contour_palette: validStops(value.custom_contour_palette)
      ? value.custom_contour_palette.map((stop) => ({
          position: stop.position,
          color: stop.color.toLowerCase(),
        }))
      : CONTOUR_PALETTES.gray.stops.map((stop) => ({ ...stop })),
    contour_reversed: value.contour_reversed === true,
  };
}

export function discreteColors(prefs: Preferences): string[] {
  return prefs.color_palette === "custom"
    ? prefs.custom_color_palette
    : COLOR_PALETTES[prefs.color_palette].colors;
}

export function contourStops(prefs: Preferences): ContourStop[] {
  const stops =
    prefs.contour_palette === "custom"
      ? prefs.custom_contour_palette
      : CONTOUR_PALETTES[prefs.contour_palette].stops;
  return prefs.contour_reversed
    ? stops
        .map((stop) => ({ position: 1 - stop.position, color: stop.color }))
        .reverse()
    : stops;
}

export interface CompiledContour {
  positions: number[];
  colors: number[];
}

export function compileContour(stops: readonly ContourStop[]): CompiledContour {
  return {
    positions: stops.map((stop) => stop.position),
    colors: stops.map((stop) => Number.parseInt(stop.color.slice(1), 16)),
  };
}

export const DEFAULT_CONTOUR = compileContour(CONTOUR_PALETTES.viridis.stops);

export function sampleContour(
  palette: CompiledContour,
  t: number,
): readonly [number, number, number, number] {
  const position = Math.min(1, Math.max(0, t));
  const index = Math.max(
    0,
    Math.min(
      palette.colors.length - 2,
      upperBound(palette.positions, position) - 1,
    ),
  );
  const a = palette.colors[index] as number;
  const b = palette.colors[index + 1] as number;
  const start = palette.positions[index] as number;
  const end = palette.positions[index + 1] as number;
  const fraction = (position - start) / (end - start);
  const channel = (shift: number): number =>
    (((a >> shift) & 255) * (1 - fraction) + ((b >> shift) & 255) * fraction) /
    255;
  return [channel(16), channel(8), channel(0), 1];
}
