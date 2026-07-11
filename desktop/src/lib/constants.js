// Ported from the Chrome extension's popup.js — same form, same fixed lists.
export const FORM_URL = "https://techzu.fillout.com/t/uhz6TddCX2us";

export const PROJECTS = ["Bookland ERP", "Builder Alliance", "Dr Cool", "Hydroflux", "NewERP",
  "Prowork", "Rina CRM", "SME Taskhub", "VSB", "Worksite Mini ERP", "ZuPOS"];

export const CATEGORIES = ["Meeting (General)", "Meeting (Technical)", "Development",
  "Code Review", "Miscellaneous"];

export const CATEGORY_COLORS = {
  "Meeting (General)": "#f59e0b",
  "Meeting (Technical)": "#38bdf8",
  "Development": "#8b5cf6",
  "Code Review": "#22c55e",
  "Miscellaneous": "#ef4444",
};
const CATEGORY_FALLBACK_COLOR = "#64748b";
export function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_FALLBACK_COLOR;
}

export const PROJECT_COLORS = {
  "Bookland ERP": "#ec4899",
  "Builder Alliance": "#14b8a6",
  "Dr Cool": "#06b6d4",
  "Hydroflux": "#6366f1",
  "NewERP": "#a855f7",
  "Prowork": "#84cc16",
  "Rina CRM": "#f97316",
  "SME Taskhub": "#0ea5e9",
  "VSB": "#d946ef",
  "Worksite Mini ERP": "#10b981",
  "ZuPOS": "#eab308",
};
const PROJECT_FALLBACK_COLOR = "#64748b";
export function projectColor(project) {
  return PROJECT_COLORS[project] || PROJECT_FALLBACK_COLOR;
}
