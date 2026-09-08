export function hasHttpResources(html) {
  // About links navigate only after a click; they do not load resources.
  const resources = html
    .replace(
      /(<a\b[^>]*\bhref=")https:\/\/github\.com\/tanged123\/signalscope(?:#readme|\/issues)(")/g,
      "$1$2",
    )
    .replace(
      /((?:\\n|\n)[ \t]*)http:\/\/www\.apache\.org\/licenses\/(?:LICENSE-2\.0)?(?=\\n|\n)/g,
      "$1",
    );
  return /\bhttps?:\/\//i.test(resources);
}
