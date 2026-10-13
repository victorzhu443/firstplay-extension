// node tests/fill.test.mjs — the pure pieces of the filler: option picking,
// the text read-back rule, the Hispanic/Latino entry rule, the run record's
// field rows, and the unique-label rule in locate. No browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { el, documentOf } from "./stub_dom.mjs";

class Ev { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } }
function load(doc) {
  const sandbox = {
    document: doc, console, CSS: { escape: (s) => s }, setTimeout, clearTimeout, performance,
    MessageChannel, requestAnimationFrame: (f) => setTimeout(f, 0), Map, Set, Promise,
    Event: Ev, MouseEvent: Ev, KeyboardEvent: Ev, FocusEvent: Ev,
    HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
  };
  vm.runInNewContext(readFileSync(new URL("../src/fill.js", import.meta.url), "utf8"), sandbox);
  return sandbox.FirstPlay;
}

const F = load(documentOf([]))._fill;

// --- pickOption: exact, unique prefix, ambiguity
const texts = (o) => o;
assert.equal(F.pickOption(["Yes", "No"], texts, "no"), "No");
assert.equal(F.pickOption(["Cornell University", "Cornell College"], texts, "Cornell"), null, "a prefix two options share is nobody's answer");
assert.equal(F.pickOption(["Cornell University", "Columbia"], texts, "Cornell"), "Cornell University");
assert.equal(F.pickOption(["Ithaca, New York, United States", "Ithaca, New York, United States"], texts, "Ithaca, NY"), "Ithaca, New York, United States", "a geocoder's duplicate is one answer");

// --- textHolds: the read-back rule for text controls
assert.equal(F.textHolds("Ada Lovelace", "Ada Lovelace", "text"), true);
assert.equal(F.textHolds("ada  lovelace", "Ada Lovelace", "text"), true, "case and spacing are the page's business");
assert.equal(F.textHolds("", "Ada Lovelace", "text"), false, "an empty field did not take the write");
assert.equal(F.textHolds("Ada", "Ada Lovelace", "text"), false, "a truncated value is not the value");
assert.equal(F.textHolds("https://github.com/ada", "github.com/ada", "url"), true, "a page that decorates the value still holds it");
assert.equal(F.textHolds("Lovelace, Ada", "Ada Lovelace", "text"), false, "reordered is not the value");
assert.equal(F.textHolds("something else entirely", "No", "text"), false, "a short value inside unrelated text does not count");
assert.equal(F.textHolds("(301) 555-0100", "301-555-0100", "tel"), true, "a mask reformats; digits agree");
assert.equal(F.textHolds("+1 (301) 555-0100", "3015550100", "text"), true, "a mask that adds the country code");
assert.equal(F.textHolds("301-555-0100", "+1 301 555 0100", "tel"), true, "or drops it");
assert.equal(F.textHolds("(301) 555-0199", "301-555-0100", "tel"), false, "different digits are a different number");
assert.equal(F.textHolds("$85,000", "85000", "text"), true, "a currency mask decorates a number; the digits are the value");
assert.equal(F.textHolds("85,000", "85000", "text"), true);
assert.equal(F.textHolds("$8,500", "85000", "text"), false, "different digits are a different number");
assert.equal(F.textHolds("", "85000", "text"), false);

// --- scrubWhy: no quoted value reaches the run record, whichever quote the reason used
assert.equal(F.scrubWhy('no option matching "Cornell University" among A | B'), 'no option matching "…" among A | B');
assert.equal(F.scrubWhy("this is a yes/no question; 'Ithaca, NY' is not an answer to it"), "this is a yes/no question; '…' is not an answer to it");
assert.equal(F.scrubWhy("you answered 'Yes' above, so this needs your detail"), "you answered '…' above, so this needs your detail");
assert.equal(F.scrubWhy("the form's lookup returned nothing"), "the form's lookup returned nothing", "an apostrophe is not a quote");
assert.equal(F.scrubWhy("2 fields on this page share the label Other — left for you"), "2 fields on this page share the label Other — left for you");
assert.equal(F.textHolds("", "May 2024", "date"), false, "a date input that rejected the value reads empty");
assert.equal(F.textHolds("2024-05-01", "2024-05-01", "date"), true);

// --- hispanicAnswerFrom: only the plan's own entry, exactly
assert.equal(F.hispanicAnswerFrom(undefined), null, "an older backend sends no entry: nothing is written");
assert.equal(F.hispanicAnswerFrom(null), null);
assert.equal(F.hispanicAnswerFrom({ value: "No", values: [], needs_review: true }), null, "needs_review is left alone even with a value");
assert.equal(F.hispanicAnswerFrom({ value: "No", values: [], skipped: "you skip this" }), null);
assert.equal(F.hispanicAnswerFrom({ value: null, values: [] }), null);
assert.equal(F.hispanicAnswerFrom({ value: "  ", values: [] }), null);
assert.equal(F.hispanicAnswerFrom({ value: "Decline To Self Identify", values: [] }), "Decline To Self Identify");
assert.equal(F.hispanicAnswerFrom({ value: null, values: ["Yes"] }), "Yes");

// --- fieldRecord: the run record's field row carries no value
const row = F.fieldRecord({ field_key: "q7", label: "x".repeat(90), source: "model_decision", confidence: 0.8765, value: "SECRET" }, "failed", false,
  'no option matching "SECRET" among A | B');
assert.equal(row.label.length, 60, "labels are cut at 60");
assert.equal(row.source, "model_decision");
assert.equal(row.confidence, 0.88);
assert.equal(row.ok, false);
assert.equal(row.state, "failed");
assert.equal(row.why.includes("SECRET"), false, "quoted values inside a reason are blanked");
assert.equal(row.why, 'no option matching "…" among A | B');
assert.equal("value" in row, false);
assert.equal("chose" in row, false);
const ok = F.fieldRecord({ field_key: "first_name", label: "First Name", source: "memory", confidence: 1 }, "filled", true);
assert.deepEqual(Object.keys(ok).sort(), ["confidence", "key", "label", "ok", "source", "state"]);
assert.deepEqual(F.fieldRecord({}, "review", false).source, null);

// --- locate: by id first; the label fallback must be unique
const twoOther = documentOf([
  el("label", { text: "Other", attrs: { for: "a1" } }), el("input", { id: "a1", type: "text" }),
  el("label", { text: "Other", attrs: { for: "b2" } }), el("input", { id: "b2", type: "text" }),
  el("label", { text: "Phone", attrs: { for: "p" } }), el("input", { id: "p", type: "tel" }),
  el("input", { id: "exact_key", type: "text" }),
]);
const G = load(twoOther);
assert.equal(G.locate({ field_key: "exact_key", label: "Other" }).id, "exact_key", "an id match never consults labels");
const unique = G.locateWithReason({ field_key: "question_9", label: "Phone" });
assert.equal(unique.el.id, "p");
assert.equal(unique.why, undefined);
const ambiguous = G.locateWithReason({ field_key: "question_12", label: "Other" });
assert.equal(ambiguous.el, null, "two labels reading Other: neither is taken");
assert.match(ambiguous.why, /2 fields on this page share the label Other/);
assert.equal(G.locate({ field_key: "question_12", label: "Other" }), null);
assert.equal(JSON.stringify(G.locateWithReason({ field_key: "question_13", label: "Nothing here" })), JSON.stringify({ el: null }), "no match is silent: 'not on page'");
// Two labels pointing at the same control are one match.
const twice = load(documentOf([
  el("label", { text: "City", attrs: { for: "c" } }), el("label", { text: "City", attrs: { for: "c" } }), el("input", { id: "c", type: "text" }),
]));
assert.equal(twice.locate({ field_key: "q", label: "City" }).id, "c");

// --- pickOptionWithReason: a localised phone-country list (Haven Interactive, R50)
const fr = ["États-Unis +1", "Canada +1", "Porto Rico +1", "Afghanistan +93", "Royaume-Uni +44", "France +33"];
assert.equal(F.pickOption(fr, texts, "United States"), "États-Unis +1", "the localisation table, even with no hints from the backend");
assert.equal(F.pickOption(fr, texts, "United States", { dial_code: "+1", iso2: "US" }), "États-Unis +1", "+1 is shared, no ISO on the texts: the table decides");
assert.equal(F.pickOption(fr, texts, "Canada", { dial_code: "+1", iso2: "CA" }), "Canada +1", "the prefix rule still comes first");
assert.equal(F.pickOption(fr, texts, "United Kingdom"), "Royaume-Uni +44");
assert.equal(F.pickOption(fr, texts, "USA"), "États-Unis +1", "US/USA expand to United States first");
assert.equal(F.pickOption(fr, texts, "Germany", { dial_code: "+49" }), null, "a country the list lacks is nobody's answer");
const ja = [{ label: "アメリカ合衆国 +1", value: "US" }, { label: "カナダ +1", value: "CA" }, { label: "日本 +81", value: "JP" }, { label: "ドイツ +49", value: "DE" }];
const labelOf = (o) => o.label;
assert.equal(F.pickOption(ja, labelOf, "Japan", { dial_code: "+81" }).value, "JP", "a dial code one option carries is that option");
assert.equal(F.pickOption(ja, labelOf, "United States", { dial_code: "+1", iso2: "US" }).value, "US", "several share +1: the exposed ISO code decides");
const shared = F.pickOptionWithReason(ja, labelOf, "United States", { dial_code: "+1" });
assert.equal(shared.option, null, "several share +1 and nothing tells them apart: refused");
assert.equal(shared.why, "several countries share +1; pick yours");
assert.equal(F.pickOptionWithReason(ja, labelOf, "United States", { dial_code: "1", iso2: "us" }).option.value, "US", "hint shapes are forgiven");
assert.equal(F.pickOption(["Yes", "No", "Maybe"], texts, "Sometimes", { dial_code: "+1" }), null, "hints never touch a list that is not a phone-country list");
assert.equal(F.pickOptionWithReason(["Yes", "No"], texts, "Sometimes", { dial_code: "+1" }).why, null, "and leave the generic reason to the caller");

// --- parseDate: what a stored date can look like
const P = F.parseDate;
const d = (o) => o && [o.year, o.month, o.day, o.note].join("|");
const FIRST = "FirstPlay chose the 1st of your stored month";
assert.equal(d(P("May 2028")), `2028|5|1|${FIRST}`);
assert.equal(d(P("May 15, 2028")), "2028|5|15|");
assert.equal(d(P("May 15 2028")), "2028|5|15|");
assert.equal(d(P("15 May 2028")), "2028|5|15|");
assert.equal(d(P("2028-05-15")), "2028|5|15|");
assert.equal(d(P("2028-05")), `2028|5|1|${FIRST}`);
assert.equal(d(P("05/15/2028")), "2028|5|15|");
assert.equal(d(P("05/2028")), `2028|5|1|${FIRST}`);
assert.equal(d(P("2028")), "2028|1|1|FirstPlay chose January 1st of your stored year");
assert.equal(d(P("Sept. 2027")), `2027|9|1|${FIRST}`);
assert.equal(d(P("Dec 2027")), `2027|12|1|${FIRST}`);
assert.equal(P("Spring 2028"), null, "a season is not a month");
assert.equal(P("13/40/2028"), null);
assert.equal(P(""), null);
assert.equal(P("as soon as possible"), null);

// --- fillDatePicker: the react-datepicker popper as measured on Ashby (TensorWave, R50)
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const pad = (n) => String(n).padStart(3, "0");
function datePickerPage({ dead = false, start = { month: 10, year: 2026 } } = {}) {
  const input = el("input", { type: "text", attrs: { placeholder: "Pick date..." } });
  const wrapper = el("div", { className: "react-datepicker-wrapper" }, [el("div", { className: "react-datepicker__input-container" }, [input])]);
  const field = el("div", { attrs: { "data-field-path": "grad_date" } }, [wrapper]);
  const doc = documentOf([field]);
  const state = { ...start, open: false, nav: 0, clicks: [] };
  const close = () => { state.open = false; render(); };
  const build = () => {
    const h4 = el("h4", { text: `${MONTHS[state.month - 1]} ${state.year}` });
    const prev = el("button", { attrs: { "aria-label": "Previous month" } }); prev.click = () => step(-1);
    const next = el("button", { attrs: { "aria-label": "Next month" } }); next.click = () => step(1);
    const header = el("div", { className: "react-datepicker__header" }, [h4, prev, next]);
    const cell = (m, y, day, outside) => {
      const c = el("div", { className: `react-datepicker__day react-datepicker__day--${pad(day)}${outside ? " react-datepicker__day--outside-month" : ""}`,
        attrs: { "aria-label": `Choose Someday, ${MONTHS[m - 1]} ${ord(day)}, ${y}` } });
      c.click = () => { state.clicks.push({ label: c.getAttribute("aria-label"), outside }); input.value = `${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}/${y}`; close(); };
      return c;
    };
    const days = [];
    for (let day = 1; day <= new Date(state.year, state.month, 0).getDate(); day += 1) days.push(cell(state.month, state.year, day, false));
    const nm = state.month === 12 ? 1 : state.month + 1, ny = state.month === 12 ? state.year + 1 : state.year;
    for (let day = 1; day <= 6; day += 1) days.push(cell(nm, ny, day, true));   // the next month's first days, greyed
    return el("div", { className: "react-datepicker-popper" }, [el("div", { className: "react-datepicker" }, [header, el("div", { className: "react-datepicker__month" }, days)])]);
  };
  const render = () => {
    field.children = field.children.filter((c) => c.className !== "react-datepicker-popper");
    if (state.open) { const p = build(); p.parentElement = field; field.children.push(p); }
  };
  const step = (n) => { state.nav += 1; state.month += n; if (state.month < 1) { state.month = 12; state.year -= 1; } if (state.month > 12) { state.month = 1; state.year += 1; } render(); };
  input.click = () => { if (dead) return; state.open = true; render(); };
  return { doc, input, state };
}

{
  const page = datePickerPage();
  const D = load(page.doc)._fill;
  assert.equal(D.widgetKind(page.input), "datepicker", "an input inside .react-datepicker-wrapper is the picker's");
  const r = await D.fillDatePicker(page.input, "May 2028");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.chose, "May 1, 2028");
  assert.equal(r.note, FIRST);
  assert.equal(page.state.nav, 19, "October 2026 to May 2028 is nineteen clicks on next");
  assert.equal(page.state.clicks.length, 1);
  assert.equal(page.state.clicks[0].outside, false, "the greyed May 1st in April's grid is never the one clicked");
  assert.match(page.state.clicks[0].label, /May 1st, 2028/);
  assert.equal(page.input.value, "05/01/2028");
  assert.equal(page.state.open, false, "the popper closed");
}
{
  const page = datePickerPage();
  const r = await load(page.doc)._fill.fillDatePicker(page.input, "2026-10-15");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.chose, "October 15, 2026");
  assert.equal(r.note, null, "a full date needs no note");
  assert.equal(page.state.nav, 0);
}
{
  const page = datePickerPage();
  const r = await load(page.doc)._fill.fillDatePicker(page.input, "March 2026");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(page.state.nav, 7, "backwards works too");
  assert.match(page.state.clicks[0].label, /March 1st, 2026/);
}
{
  const page = datePickerPage();
  const r = await load(page.doc)._fill.fillDatePicker(page.input, "January 2040");
  assert.equal(r.ok, false);
  assert.equal(r.why, "date picker: could not reach January 2040 in 120 steps");
  assert.equal(page.state.clicks.length, 0, "nothing was picked");
}
{
  const page = datePickerPage({ dead: true });
  const r = await load(page.doc)._fill.fillDatePicker(page.input, "May 2028");
  assert.equal(r.ok, false);
  assert.equal(r.why, "date picker: the calendar did not open");
}
{
  const page = datePickerPage();
  const r = await load(page.doc)._fill.fillDatePicker(page.input, "as soon as possible");
  assert.equal(r.ok, false);
  assert.match(r.why, /is not a date it can pick/);
  assert.equal(page.state.open, false, "nothing was opened for a value that is not a date");
}
// Through applyPlan: the picks tier, the record, and the tooltip that says what was chosen.
{
  const page = datePickerPage();
  const outcome = await load(page.doc).applyPlan({ entries: [
    { field_key: "grad_date", label: "Expected Graduation Date", value: "May 2028", values: [], needs_review: false, source: "memory", reason: "stored as graduation_date" },
  ] }, {});
  assert.equal(outcome.filled, 1, JSON.stringify(outcome.details));
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.fields[0].state, "filled");
  assert.equal(page.input.value, "05/01/2028");
  assert.match(page.input.title, /stored as graduation_date — FirstPlay chose the 1st of your stored month/);
}

console.log("fill.test.mjs: all assertions passed");


// --- a multi react-select never toggles an option it already holds
// (Rugged Robotics, R50: the first value was picked twice and came off)
{
  const input = el("input", { id: "question_77[]", type: "text" });
  const options = [{ label: "Spring 2027 Co-Op", value: "a" }, { label: "Summer 2027 Internship", value: "b" }, { label: "Both", value: "c" }];
  const calls = [];
  const instance = {
    props: { isMulti: true, options, value: [] },
    state: { selectValue: [] },
    openMenu() {},
    selectOption(o) { calls.push(o.label); this.state.selectValue = [...this.state.selectValue, o]; this.props.value = this.state.selectValue; },
  };
  input.__reactFiber$test = { stateNode: instance, return: null };
  const M = load(documentOf([input]));
  const first = await M.fillReactSelect(input, "Both");
  const again = await M.fillReactSelect(input, "Both");
  assert.equal(first.ok, true);
  assert.equal(again.ok, true, "a held option counts as chosen");
  assert.deepEqual(calls, ["Both"], "selectOption is called once; a second pick would toggle the option off");
  assert.equal(instance.state.selectValue.length, 1);
  const extra = await M.fillReactSelect(input, "Spring 2027 Co-Op");
  assert.equal(extra.ok, true);
  assert.deepEqual(calls, ["Both", "Spring 2027 Co-Op"], "a different option on a multi is added");
}
