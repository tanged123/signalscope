import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERIES_TOKENS } from "../render/canvas-renderer";

const TOKENS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

const BAND = { dark: [0.48, 0.67], light: [0.43, 0.77] } as const;
const CHROMA_FLOOR = 0.1;
const CVD_FLOOR = 8;
const NORMAL_FLOOR = 15;
const CONTRAST_MIN = 3;
const AMBER_BAND = [55, 90] as const;
const AMBER_DELTA_FLOOR = 10;

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

type Linear = [number, number, number];

function toLinear(hex: string): Linear {
  const body = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(body.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
}

function toOklab([r, g, b]: Linear): Linear {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklch(hex: string): { l: number; c: number; h: number } {
  const [l, a, b] = toOklab(toLinear(hex));
  return {
    l,
    c: Math.hypot(a, b),
    h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
  };
}

function simulate(hex: string, kind: keyof typeof MACHADO): Linear {
  const [r, g, b] = toLinear(hex);
  const matrix = MACHADO[kind];
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return [
    clamp(matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b),
    clamp(matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b),
    clamp(matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b),
  ];
}

function deltaE(a: string, b: string, kind?: keyof typeof MACHADO): number {
  const first = toOklab(kind === undefined ? toLinear(a) : simulate(a, kind));
  const second = toOklab(kind === undefined ? toLinear(b) : simulate(b, kind));
  return (
    100 *
    Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])
  );
}

function luminance(hex: string): number {
  const [r, g, b] = toLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

function block(selector: string): string {
  const start = TOKENS.indexOf(selector);
  if (start < 0) throw new Error(`missing selector ${selector}`);
  const open = TOKENS.indexOf("{", start);
  const close = TOKENS.indexOf("}", open);
  return TOKENS.slice(open, close);
}

function token(selector: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(
    block(selector),
  );
  if (match?.[1] === undefined) {
    throw new Error(`missing token ${name} in ${selector}`);
  }
  return match[1].toLowerCase();
}

function series(selector: string): string[] {
  return SERIES_TOKENS.map((name) => token(selector, name));
}

const THEMES = [
  { name: "dark", selector: ":root", mode: "dark" },
  { name: "light", selector: ':root[data-theme="light"]', mode: "light" },
] as const;

describe("colour maths", () => {
  it("matches known OKLCh values", () => {
    const amber = oklch("#ffb648");
    expect(amber.l).toBeCloseTo(0.826, 2);
    expect(amber.c).toBeCloseTo(0.148, 2);
    expect(amber.h).toBeCloseTo(73.8, 1);
    expect(oklch("#2a78d6").h).toBeCloseTo(255.5, 1);
    expect(oklch("#008300").l).toBeCloseTo(0.529, 2);
  });

  it("matches known contrast ratios", () => {
    expect(contrast("#a9b0bc", "#0e1116")).toBeCloseTo(8.67, 1);
    expect(contrast("#4a5160", "#f7f8fa")).toBeCloseTo(7.49, 1);
  });

  it("matches a known simulated separation", () => {
    expect(deltaE("#eda100", "#1baf7a", "protan")).toBeCloseTo(9.1, 0);
  });
});

describe.each(THEMES)("$name series palette", ({ selector, mode }) => {
  const palette = series(selector);

  it("keeps every slot inside the lightness band", () => {
    const [lo, hi] = BAND[mode];
    for (const hex of palette) {
      expect(oklch(hex).l).toBeGreaterThanOrEqual(lo);
      expect(oklch(hex).l).toBeLessThanOrEqual(hi);
    }
  });

  it("keeps every slot above the chroma floor", () => {
    for (const hex of palette) {
      expect(oklch(hex).c).toBeGreaterThanOrEqual(CHROMA_FLOOR);
    }
  });

  it("separates adjacent slots under protan and deutan vision", () => {
    for (let index = 0; index < palette.length - 1; index += 1) {
      const [first, second] = [palette[index] ?? "", palette[index + 1] ?? ""];
      for (const kind of ["protan", "deutan"] as const) {
        expect(deltaE(first, second, kind)).toBeGreaterThanOrEqual(CVD_FLOOR);
      }
    }
  });

  it("separates adjacent slots under normal vision", () => {
    for (let index = 0; index < palette.length - 1; index += 1) {
      expect(
        deltaE(palette[index] ?? "", palette[index + 1] ?? ""),
      ).toBeGreaterThanOrEqual(NORMAL_FLOOR);
    }
  });

  it("reserves the amber hue band for interaction roles", () => {
    const amber = oklch(token(selector, "--amber-7")).h;
    expect(amber).toBeGreaterThanOrEqual(AMBER_BAND[0]);
    expect(amber).toBeLessThanOrEqual(AMBER_BAND[1]);
    for (const hex of palette) {
      const { h } = oklch(hex);
      expect(h < AMBER_BAND[0] || h > AMBER_BAND[1]).toBe(true);
    }
  });

  it("keeps every slot perceptually clear of the amber tokens", () => {
    for (const name of ["--amber-7", "--amber-9"] as const) {
      const amber = token(selector, name);
      for (const hex of palette) {
        expect(deltaE(hex, amber)).toBeGreaterThanOrEqual(AMBER_DELTA_FLOOR);
      }
    }
  });

  it("never reuses an amber or status token as a series colour", () => {
    const reserved = [
      "--amber-7",
      "--amber-9",
      "--status-connected",
      "--status-disconnected",
      "--status-error",
    ].map((name) => token(selector, name));
    for (const hex of palette) {
      expect(reserved).not.toContain(hex);
    }
  });
});

it("holds hue identity for each slot across themes", () => {
  const dark = series(":root");
  const light = series(':root[data-theme="light"]');
  for (let index = 0; index < dark.length; index += 1) {
    const delta = Math.abs(
      oklch(dark[index] ?? "").h - oklch(light[index] ?? "").h,
    );
    expect(Math.min(delta, 360 - delta)).toBeLessThanOrEqual(10);
  }
});

it("meets the contrast floor on the dark surface", () => {
  const surface = token(":root", "--surface-0");
  for (const hex of series(":root")) {
    expect(contrast(hex, surface)).toBeGreaterThanOrEqual(CONTRAST_MIN);
  }
});

it("records the light surface contrast trade", () => {
  const surface = token(':root[data-theme="light"]', "--surface-0");
  const ratios = series(':root[data-theme="light"]').map((hex) =>
    contrast(hex, surface),
  );
  const below = ratios.filter((ratio) => ratio < CONTRAST_MIN);
  expect(below).toHaveLength(3);
  for (const ratio of below) expect(ratio).toBeGreaterThanOrEqual(1.8);
});
