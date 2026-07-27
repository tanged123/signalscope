/**
 * Splits `derived/name = expression` into its two halves.
 *
 * The separator is the first `=` that is not part of `==`, `~=`, `<=`, or
 * `>=`, so a comparison in an unnamed expression is never mistaken for an
 * assignment. Returns null when either half is empty.
 */
export function parseFormulaInput(
  text: string,
  fallbackIndex: number,
): { path: string; expr: string } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  let separator = -1;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "=") continue;
    if (trimmed[index + 1] === "=") {
      index += 1;
      continue;
    }
    if (["=", "~", "<", ">"].includes(trimmed[index - 1] ?? "")) continue;
    separator = index;
    break;
  }

  if (separator === -1) {
    return { path: `derived/expr_${String(fallbackIndex)}`, expr: trimmed };
  }
  const path = trimmed.slice(0, separator).trim();
  const expr = trimmed.slice(separator + 1).trim();
  if (path === "" || expr === "") return null;
  return { path, expr };
}

export interface FormulaEdit {
  text: string;
  caret: number;
}

/** Quotes a signal path using the expression dialect's MATLAB-style escape. */
export function quoteSignalPath(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

/** Replaces `[start, end)` with one quoted signal reference. */
export function insertSignalReference(
  text: string,
  path: string,
  start: number,
  end: number,
): FormulaEdit {
  const from = Math.min(Math.max(start, 0), text.length);
  const to = Math.min(Math.max(end, from), text.length);
  const reference = quoteSignalPath(path);
  return {
    text: `${text.slice(0, from)}${reference}${text.slice(to)}`,
    caret: from + reference.length,
  };
}
