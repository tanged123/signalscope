export interface ExpressionReference {
  operation: "$" | "deriv" | "integ" | "smooth";
  path: string;
  window: number | null;
}

const REFERENCE_PATTERN =
  /(deriv|integ|smooth|\$)\(\s*"([^"]+)"\s*(?:,\s*(\d+)\s*)?\)/g;

export function parseExpressionReferences(
  expression: string,
): ExpressionReference[] {
  return Array.from(expression.matchAll(REFERENCE_PATTERN), (match) => ({
    operation: match[1] as ExpressionReference["operation"],
    path: match[2] ?? "",
    window: match[3] === undefined ? null : Number(match[3]),
  }));
}

export function validateExpression(expression: string): void {
  if (parseExpressionReferences(expression).length === 0) {
    throw new Error(
      'Reference at least one signal, for example $("rocket/velocity_body/x")',
    );
  }
  if (
    /[;{}[\]`]|\b(?:document|window|globalThis|fetch|eval)\b/.test(expression)
  ) {
    throw new Error("Expression contains unsupported syntax");
  }
}
