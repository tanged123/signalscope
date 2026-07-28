import { quoteSignalPath } from "./formula";
import type { QuickTransform } from "../ui/panel";

const SUFFIX: Record<QuickTransform, string> = {
  gradient: "dot",
  cumtrapz: "int",
  movmean: "avg",
  abs: "abs",
};

/** Returns a collision-resistant derived path and a safely quoted expression. */
export function quickTransform(
  path: string,
  kind: QuickTransform,
): [path: string, expr: string] {
  const stem =
    path
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "_")
      .replaceAll(/^_+|_+$/g, "") || "signal";
  const name = `derived/${stem}_${SUFFIX[kind]}`;
  const source = quoteSignalPath(path);
  const expr =
    kind === "movmean" ? `movmean(${source}, 51)` : `${kind}(${source})`;
  return [name, expr];
}
