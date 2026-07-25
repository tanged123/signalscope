/** Subsequence match score; higher is better, null means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  if (needle === "") return 0;
  let score = 0;
  let index = 0;
  let run = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found === -1) return null;
    run = found === index ? run + 1 : 1;
    score += run + (found === 0 ? 2 : 0);
    index = found + 1;
  }
  return score - (haystack.length - needle.length) * 0.01;
}
