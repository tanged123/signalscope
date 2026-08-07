import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLOR_SLOTS, SERIES_TOKENS } from "../render/canvas-renderer";

const TOKENS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

const MATLAB_DEFAULT = [
  "#0072bd",
  "#d95319",
  "#edb120",
  "#7e2f8e",
  "#77ac30",
  "#4dbeee",
  "#a2142f",
] as const;

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
  return SERIES_TOKENS.slice(0, COLOR_SLOTS).map((name) =>
    token(selector, name),
  );
}

const THEMES = [
  { name: "dark", selector: ":root" },
  { name: "light", selector: ':root[data-theme="light"]' },
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

describe.each(THEMES)("$name series palette", ({ selector }) => {
  const palette = series(selector);

  it("uses MATLAB's canonical default order", () => {
    expect(palette).toEqual(MATLAB_DEFAULT);
  });

  it("rolls slot eight over to MATLAB blue", () => {
    expect(token(selector, "--series-8")).toBe(MATLAB_DEFAULT[0]);
  });

  it("does not reuse an amber or status token as a series colour", () => {
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

it("holds exact series identity across themes", () => {
  expect(series(":root")).toEqual(series(':root[data-theme="light"]'));
});

it("keeps a bundled fallback for mono control glyphs", () => {
  expect(TOKENS).toMatch(
    /--font-mono:\s*JetBrains Mono,\s*"DejaVu Sans",\s*ui-monospace/,
  );
});
