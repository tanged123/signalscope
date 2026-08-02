import {
  formulaAssignmentSeparator,
  quoteSignalPath,
  type FormulaEdit,
} from "./formula";

type CompletionKind = "function" | "constant" | "time" | "signal";

export interface CompletionContext {
  source: "language" | "signal";
  query: string;
  start: number;
  end: number;
}

export interface FormulaCompletion {
  kind: CompletionKind;
  label: string;
  detail: string;
  replacement: string;
  caretOffset: number;
}

export interface FormulaBundleCompletion {
  localPath: string;
  runCount: number;
}

const LANGUAGE = [
  ["abs", "absolute value", "abs()", 4],
  ["sqrt", "square root", "sqrt()", 5],
  ["exp", "natural exponential", "exp()", 4],
  ["log", "natural logarithm", "log()", 4],
  ["log2", "base-2 logarithm", "log2()", 5],
  ["log10", "base-10 logarithm", "log10()", 6],
  ["sin", "sine", "sin()", 4],
  ["cos", "cosine", "cos()", 4],
  ["tan", "tangent", "tan()", 4],
  ["asin", "inverse sine", "asin()", 5],
  ["acos", "inverse cosine", "acos()", 5],
  ["atan", "inverse tangent", "atan()", 5],
  ["atan2", "two-argument arctangent", "atan2(, )", 6],
  ["sinh", "hyperbolic sine", "sinh()", 5],
  ["cosh", "hyperbolic cosine", "cosh()", 5],
  ["tanh", "hyperbolic tangent", "tanh()", 5],
  ["rad2deg", "radians to degrees", "rad2deg()", 8],
  ["deg2rad", "degrees to radians", "deg2rad()", 8],
  ["hypot", "Euclidean magnitude", "hypot(, )", 6],
  ["floor", "round toward negative infinity", "floor()", 6],
  ["ceil", "round toward positive infinity", "ceil()", 5],
  ["round", "round to nearest integer", "round()", 6],
  ["fix", "round toward zero", "fix()", 4],
  ["sign", "signum", "sign()", 5],
  ["mod", "floor remainder", "mod(, )", 4],
  ["rem", "truncated remainder", "rem(, )", 4],
  ["min", "minimum", "min(, )", 4],
  ["max", "maximum", "max(, )", 4],
  ["power", "element-wise power", "power(, )", 6],
  ["gradient", "time derivative", "gradient()", 9],
  ["cumtrapz", "cumulative trapezoidal integral", "cumtrapz()", 9],
  ["movmean", "moving mean", "movmean(, 51)", 8],
  ["pi", "circle constant", "pi", 2],
  ["Inf", "positive infinity", "Inf", 3],
  ["NaN", "not a number", "NaN", 3],
  ["eps", "machine epsilon", "eps", 3],
  ["t", "sample time", "t", 1],
] as const;

export function completionContext(
  text: string,
  caret: number,
  manual: boolean,
): CompletionContext | null {
  const at = Math.min(Math.max(caret, 0), text.length);
  const separator = formulaAssignmentSeparator(text);
  if (separator >= 0 && at <= separator) return null;
  const expressionStart = separator >= 0 ? separator + 1 : 0;

  let quote: "'" | '"' | null = null;
  let quoteStart = -1;
  for (let index = expressionStart; index < at; index += 1) {
    const character = text[index];
    if (quote === null) {
      if (character === "'" || character === '"') {
        quote = character;
        quoteStart = index;
      }
      continue;
    }
    if (character !== quote) continue;
    if (text[index + 1] === quote && index + 1 < at) {
      index += 1;
      continue;
    }
    quote = null;
    quoteStart = -1;
  }

  if (quote !== null) {
    let end = at;
    for (let index = at; index < text.length; index += 1) {
      if (text[index] !== quote) continue;
      if (text[index + 1] === quote) {
        index += 1;
        continue;
      }
      end = index + 1;
      break;
    }
    return {
      source: "signal",
      query: text
        .slice(quoteStart + 1, at)
        .replaceAll(`${quote}${quote}`, quote),
      start: quoteStart,
      end,
    };
  }

  let start = at;
  while (
    start > expressionStart &&
    /[A-Za-z0-9_]/.test(text[start - 1] ?? "")
  ) {
    start -= 1;
  }
  if (start < at && /[A-Za-z_]/.test(text[start] ?? "")) {
    return {
      source: "language",
      query: text.slice(start, at),
      start,
      end: at,
    };
  }
  return manual ? { source: "language", query: "", start: at, end: at } : null;
}

function matchRank(label: string, query: string): number | null {
  const candidate = label.toLowerCase();
  const needle = query.toLowerCase();
  if (needle === "") return 0;
  const short = candidate.split("/").at(-1) ?? candidate;
  if (candidate.startsWith(needle) || short.startsWith(needle)) return 0;
  return candidate.includes(needle) ? 1 : null;
}

export function formulaCompletions(
  context: CompletionContext,
  signalPaths: readonly string[],
  bundles: readonly FormulaBundleCompletion[] = [],
): FormulaCompletion[] {
  const entries: FormulaCompletion[] =
    context.source === "signal"
      ? [
          ...signalPaths.map((path) => {
            const replacement = quoteSignalPath(path);
            return {
              kind: "signal" as const,
              label: path,
              detail: "signal",
              replacement,
              caretOffset: replacement.length,
            };
          }),
          ...bundles.map(({ localPath, runCount }) => {
            const replacement = quoteSignalPath(localPath);
            return {
              kind: "signal" as const,
              label: localPath,
              detail: `${String(runCount)} sources`,
              replacement,
              caretOffset: replacement.length,
            };
          }),
        ]
      : LANGUAGE.map(([label, detail, replacement, caretOffset]) => ({
          kind:
            label === "t"
              ? ("time" as const)
              : ["pi", "Inf", "NaN", "eps"].includes(label)
                ? ("constant" as const)
                : ("function" as const),
          label,
          detail,
          replacement,
          caretOffset,
        }));

  return entries
    .map((entry) => ({ entry, rank: matchRank(entry.label, context.query) }))
    .filter(
      (match): match is { entry: FormulaCompletion; rank: number } =>
        match.rank !== null,
    )
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.entry.label.localeCompare(right.entry.label),
    )
    .slice(0, 50)
    .map((match) => match.entry);
}

export function applyCompletion(
  text: string,
  context: CompletionContext,
  completion: FormulaCompletion,
): FormulaEdit {
  return {
    text:
      text.slice(0, context.start) +
      completion.replacement +
      text.slice(context.end),
    caret: context.start + completion.caretOffset,
  };
}
