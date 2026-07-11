// Ported from the Chrome extension's popup.js: the form's Name dropdown
// options are static, embedded in the server-rendered __NEXT_DATA__ JSON.
// Parse them out of the raw HTML — no browser, no DOM scraping.
export function parseNames(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  let names = [];
  (function walk(o) {
    if (o && typeof o === "object") {
      const so = o.name === "Name" && o.template && o.template.options && o.template.options.staticOptions;
      if (so) {
        names = so
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
  return names.sort((a, b) => a.localeCompare(b));
}
