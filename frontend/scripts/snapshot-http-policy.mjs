import { readFileSync } from "node:fs";

const notices = readFileSync(
  new URL("../src/app/palette-notices.txt", import.meta.url),
  "utf8",
);
const noticeTemplate = "`" + notices.replace(/\\|`|\$\{/g, "\\$&") + "`";

export function hasHttpResources(html) {
  // About links navigate only after a click; they do not load resources.
  const resources = html
    .replace(
      /(<a\b[^>]*\bhref=")https:\/\/github\.com\/tanged123\/signalscope(?:#readme|\/issues)(")/g,
      "$1$2",
    )
    // Only the complete bundled notice literal is exempt, never a URL alone.
    .replaceAll(JSON.stringify(notices), '""')
    .replaceAll(noticeTemplate, "``");
  return /\bhttps?:\/\//i.test(resources);
}
