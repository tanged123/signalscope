import {
  DERIVED_SOURCE_KEY,
  type Catalog,
  type CatalogSeries,
} from "./catalog";

export type SelectorAttr = {
  key: "unit" | "kind";
  value: string;
};

export interface Selector {
  channelText: string;
  channel: RegExp;
  sourceText: string | null;
  source: RegExp | null;
  attrs: SelectorAttr[];
}

export type SelectorParse =
  | { ok: true; selector: Selector }
  | { ok: false; error: string };

export interface SelectorMatch {
  series: readonly CatalogSeries[];
  signalCount: number;
  sourceCount: number;
}

export function compileGlob(pattern: string): RegExp | null {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) return null;
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else if (character === "|") {
      source += "|";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) return null;
      const body = pattern.slice(index + 1, end);
      if (!/^[a-zA-Z0-9](?:-[a-zA-Z0-9])?$/.test(body)) return null;
      source += `[${body}]`;
      index = end;
    } else {
      source += /[-a-zA-Z0-9_/:]/.test(character)
        ? character
        : `\\${character}`;
    }
  }

  try {
    return new RegExp(`^(?:${source})$`);
  } catch {
    return null;
  }
}

export function parseSelector(input: string): SelectorParse {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, error: "selector is empty" };

  const channelText = tokens.shift() ?? "";
  const channel = compileGlob(channelText);
  if (!channel) return { ok: false, error: "invalid channel glob" };

  let sourceText: string | null = null;
  let source: RegExp | null = null;
  const attrs: SelectorAttr[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) return { ok: false, error: "unexpected end" };
    if (token === "@" || token.startsWith("@")) {
      if (sourceText !== null) return { ok: false, error: "duplicate source" };
      const text = token === "@" ? tokens[++index] : token.slice(1);
      if (text === undefined || text === "") {
        return { ok: false, error: "source glob is empty" };
      }
      source = compileGlob(text);
      if (!source) return { ok: false, error: "invalid source glob" };
      sourceText = text;
      continue;
    }

    const separator = token.indexOf(":");
    if (separator <= 0 || separator === token.length - 1) {
      return { ok: false, error: `unexpected token: ${token}` };
    }
    const key = token.slice(0, separator);
    if (key !== "unit" && key !== "kind") {
      return { ok: false, error: `unknown attribute: ${key}` };
    }
    attrs.push({ key, value: token.slice(separator + 1) });
  }

  return {
    ok: true,
    selector: { channelText, channel, sourceText, source, attrs },
  };
}

export function seriesMatches(
  selector: Selector,
  series: CatalogSeries,
): boolean {
  if (!selector.channel.test(series.channel)) return false;
  if (selector.source !== null && !selector.source.test(series.sourceName))
    return false;
  for (const attr of selector.attrs) {
    if (attr.key === "unit" && series.summary.unit !== attr.value) return false;
    if (attr.key === "kind") {
      const derived = series.sourceKey === DERIVED_SOURCE_KEY;
      if (
        attr.value === "derived"
          ? !derived
          : attr.value === "signal"
            ? derived
            : true
      ) {
        return false;
      }
    }
  }
  return true;
}

export function evaluateSelector(
  catalog: Catalog,
  input: string,
): SelectorMatch | null {
  const parsed = parseSelector(input);
  if (!parsed.ok) return null;
  const series = catalog
    .allSeries()
    .filter((entry) => seriesMatches(parsed.selector, entry));
  return {
    series,
    signalCount: series.length,
    sourceCount: new Set(series.map((entry) => entry.sourceKey)).size,
  };
}
