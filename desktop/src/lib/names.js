// Ported from the Chrome extension's popup.js: Name/Project/Category dropdown
// options are static, embedded in the server-rendered __NEXT_DATA__ JSON.
// Parse them out of the raw HTML — no browser, no DOM scraping.
export function parseDropdownOptions(html, fieldName) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  let opts = [];
  (function walk(o) {
    if (o && typeof o === "object") {
      const so = o.name === fieldName && o.template && o.template.options && o.template.options.staticOptions;
      if (so) {
        opts = so
          .map((x) => {
            try {
              return x.value.logic.value;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
      for (const k in o) walk(o[k]);
    }
  })(data);
  return opts;
}
export function parseNames(html) {
  return parseDropdownOptions(html, "Name").sort((a, b) => a.localeCompare(b));
}
