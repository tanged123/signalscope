import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasHttpResources } from "./snapshot-http-policy.mjs";

it("permits only the complete bundled notice literal", () => {
  const notices = readFileSync(
    new URL("../src/app/palette-notices.txt", import.meta.url),
    "utf8",
  );
  for (const literal of [JSON.stringify(notices), "`" + notices + "`"]) {
    expect(hasHttpResources(`<script>const notices=${literal};</script>`)).toBe(
      false,
    );
  }
});

it("rejects Apache resource URLs, including whitespace normalized by URL parsing", () => {
  for (const url of [
    "http://www.apache.org/licenses/",
    "http://www.apache.org/licenses/LICENSE-2.0",
  ]) {
    expect(hasHttpResources(`<img src="${url}">`)).toBe(true);
    expect(hasHttpResources(`fetch("${url}")`)).toBe(true);
    expect(new URL(`\n  ${url}\n`).href).toBe(url);
    for (const newline of ["\n", "\\n"]) {
      expect(
        hasHttpResources(
          `<script>fetch(\`${newline}  ${url}${newline}\`)</script>`,
        ),
      ).toBe(true);
    }
  }
});

it("permits only inert About navigation links", () => {
  for (const suffix of ["#readme", "/issues"]) {
    const url = `https://github.com/tanged123/signalscope${suffix}`;
    expect(hasHttpResources(`<a href="${url}">Open</a>`)).toBe(false);
    expect(hasHttpResources(`<script src="${url}"></script>`)).toBe(true);
    expect(hasHttpResources(`fetch("${url}")`)).toBe(true);
    expect(hasHttpResources(`<a href="${url}/other">Open</a>`)).toBe(true);
  }
  expect(hasHttpResources('<a href="https://example.com">Open</a>')).toBe(true);
  expect(hasHttpResources('<img src="https://example.com/image.png">')).toBe(
    true,
  );
  expect(
    hasHttpResources(
      '<a href="https://github.com/tanged123/signalscope#readme" ping="https://example.com">Open</a>',
    ),
  ).toBe(true);
});
