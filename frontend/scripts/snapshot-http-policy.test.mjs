import { expect, it } from "vitest";
import { hasHttpResources } from "./snapshot-http-policy.mjs";

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
