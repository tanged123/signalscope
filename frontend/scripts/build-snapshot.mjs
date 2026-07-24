import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDirectory, "..");
const distDirectory = resolve(frontendRoot, "dist");
const indexPath = resolve(distDirectory, "index.html");
let html = await readFile(indexPath, "utf8");

for (const match of [
  ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g),
]) {
  const [element, href] = match;
  if (href === undefined) continue;
  const cssPath = resolve(distDirectory, href.replace(/^\//, ""));
  let css = await readFile(cssPath, "utf8");
  css = await inlineCssAssets(css, cssPath);
  html = html.replace(element, `<style>${css}</style>`);
}

for (const match of [
  ...html.matchAll(
    /<script[^>]+type="module"[^>]+src="([^"]+)"[^>]*><\/script>/g,
  ),
]) {
  const [element, source] = match;
  if (source === undefined) continue;
  const scriptPath = resolve(distDirectory, source.replace(/^\//, ""));
  const script = await readFile(scriptPath, "utf8");
  html = html.replace(
    element,
    `<script type="module">${escapeClosingScript(script)}</script>`,
  );
}

await writeFile(resolve(distDirectory, "snapshot-template.html"), html);

async function inlineCssAssets(css, cssPath) {
  const matches = [...css.matchAll(/url\(([^)]+)\)/g)];
  for (const match of matches) {
    const [expression, rawPath] = match;
    if (rawPath === undefined) continue;
    const assetPath = rawPath.replace(/^['"]|['"]$/g, "");
    if (assetPath.startsWith("data:")) continue;
    const resolvedAsset = assetPath.startsWith("/")
      ? resolve(distDirectory, assetPath.slice(1))
      : resolve(dirname(cssPath), assetPath);
    const bytes = await readFile(resolvedAsset);
    const mediaType = assetPath.endsWith(".woff2")
      ? "font/woff2"
      : "application/octet-stream";
    css = css.replace(
      expression,
      `url(data:${mediaType};base64,${bytes.toString("base64")})`,
    );
  }
  return css;
}

function escapeClosingScript(source) {
  return source.replaceAll("</script", "<\\/script");
}
