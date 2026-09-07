export function hasHttpResources(html) {
  // About links navigate only after a click; they do not load resources.
  const resources = html.replace(
    /(<a\b[^>]*\bhref=")https:\/\/github\.com\/tanged123\/signalscope(?:#readme|\/issues)(")/g,
    "$1$2",
  );
  return /\bhttps?:\/\//i.test(resources);
}
