import { expect, it } from "vitest";
import { hasHttpResources } from "./snapshot-http-policy.mjs";

it("permits Apache license references as inert notice text, never resource attributes or fetch calls", () => {
  for (const url of [
    "http://www.apache.org/licenses/",
    "http://www.apache.org/licenses/LICENSE-2.0",
  ]) {
    expect(hasHttpResources("\\n    " + url + "\\n")).toBe(false);
    expect(hasHttpResources("\n    " + url + "\n")).toBe(false);
    expect(hasHttpResources(`<img src="${url}">`)).toBe(true);
    expect(hasHttpResources(`fetch("${url}")`)).toBe(true);
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
