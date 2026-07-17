// Headless timesheet submission via Fillout's HTTP API — no browser, no
// in-app webview. Used on Android (Tauri mobile is single-window, so the
// desktop auto-fill window isn't available). Desktop keeps using the webview
// automation; this path is gated behind isMobile() in the store.
//
// How it works (reverse-engineered from the live form, confirmed end-to-end):
//   - A submission is ONE POST to /v1/flow/<parentFlow>/continue.
//   - Auth is a client-generated sessionToken (any random string); a /init
//     call opens the session first. submissionId (uuid) and each entry's `_t`
//     token are ALSO client-generated — the server accepts them as-is.
//   - Each timesheet entry is embedded in the parent's `acFB` field as a
//     fully-formed sub-submission (step e2oh) marked "finished". No separate
//     sub-flow call is needed.
//
// Option IDs (name/project/category -> optionId) are parsed live from each
// form's __NEXT_DATA__ (people and projects can change). The structural
// step/field IDs are stable form-definition constants, hardcoded below.
import { invoke } from "@tauri-apps/api/core";
import { FORM_URL } from "./constants.js";

// ponytail: hardcoded form/step/field IDs — stable unless the form is rebuilt
// from scratch, in which case every ID changes and this needs regenerating.
const PARENT_FLOW = FORM_URL.match(/\/t\/([^/?#]+)/)[1]; // uhz6TddCX2us
const SUBFORM_URL = "https://techzu.fillout.com/t/kwgd21pozYus";
const STEP_PARENT = "sZmQ";
const STEP_ENTRY = "e2oh";
const F_NAME = "9FTQ";
const F_ENTRIES = "acFB";
const F_DATE = "eiua";
const F_CATEGORY = "2sMY";
const F_DESC = "bDEW";
const F_PROJECT = "qbgn";
const F_TIME = "u6cf";

function randToken(n = 32) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const r = crypto.getRandomValues(new Uint8Array(n));
  for (let i = 0; i < n; i++) s += a[r[i] % a.length];
  return s;
}

// Walk __NEXT_DATA__ for a widget by its display name and return
// { optionValue: optionId } from its static dropdown options.
function parseOptionMap(html, widgetName) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return {};
  let data;
  try { data = JSON.parse(m[1]); } catch { return {}; }
  const out = {};
  (function walk(o) {
    if (o && typeof o === "object") {
      const so = o.name === widgetName && o.template && o.template.options && o.template.options.staticOptions;
      if (so) {
        for (const opt of so) {
          try { out[opt.value.logic.value] = opt.id; } catch {}
        }
      }
      for (const k in o) walk(o[k]);
    }
  })(data);
  return out;
}

function pick(map, value, label) {
  const id = map[value];
  if (!id) throw new Error(`"${value}" isn't a valid ${label} on the form`);
  return { value, selectedOptionIds: [id] };
}

// entries: [{ project, category, description, hhmm }]
export async function submitHeadless(name, date, entries) {
  if (!name) throw new Error("Pick your name in Settings first.");
  if (!entries.length) throw new Error("No entries to submit.");

  const [parentHtml, subHtml] = await Promise.all([
    invoke("fetch_form_html", { url: FORM_URL }),
    invoke("fetch_form_html", { url: SUBFORM_URL }),
  ]);
  const nameMap = parseOptionMap(parentHtml, "Name");
  const projMap = parseOptionMap(subHtml, "Project");
  const catMap = parseOptionMap(subHtml, "Work Category");

  const nameField = pick(nameMap, name, "name");

  const acFB = entries.map((e) => {
    const id = crypto.randomUUID();
    return {
      ___fillout_submission_id: id,
      urlParams: { name, date, _t: randToken() },
      stepHistory: { path: [STEP_ENTRY] },
      calculations: {},
      globals: { submissionId: id },
      quiz: {},
      [STEP_ENTRY]: {
        [F_CATEGORY]: pick(catMap, e.category, "work category"),
        [F_DESC]: { value: e.description || "" },
        [F_PROJECT]: pick(projMap, e.project, "project"),
        [F_TIME]: { value: e.hhmm },
      },
      sngj: {},
      ___fillout_submission_status: "finished",
    };
  });

  const sessionToken = randToken();
  const body = {
    mode: "live",
    sessionToken,
    stepId: STEP_PARENT,
    model: {
      urlParams: { name, date },
      stepHistory: { path: [STEP_PARENT] },
      calculations: {},
      globals: { submissionId: crypto.randomUUID() },
      quiz: {},
      jrRH: {},
      [STEP_PARENT]: {
        [F_NAME]: nameField,
        [F_ENTRIES]: { value: acFB },
        [F_DATE]: { value: date },
      },
    },
    version: "v2",
    updateSequenceNumber: 1,
    metadata: {
      timeToCompleteInSeconds: 30,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  };

  const base = `https://api.fillout.com/v1/flow/${PARENT_FLOW}`;
  await invoke("fillout_post", { url: `${base}/init`, body: JSON.stringify({ mode: "live", sessionToken }) });
  await invoke("fillout_post", { url: `${base}/continue`, body: JSON.stringify(body) });
  return entries.length;
}
