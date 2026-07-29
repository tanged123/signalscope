export function exportFileStem(title: string, fallback: string): string {
  const safe = title
    .trim()
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll(/\p{Cc}/gu, "-")
    .trim()
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return safe || fallback;
}
