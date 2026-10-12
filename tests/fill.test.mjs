// node tests/fill.test.mjs — the pure pieces of the filler: option picking,
// the text read-back rule, the Hispanic/Latino entry rule, the run record's
// field rows, and the unique-label rule in locate. No browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { el, documentOf } from "./stub_dom.mjs";

function load(doc) {
  const sandbox = {
    document: doc, console, CSS: { escape: (s) => s }, setTimeout, clearTimeout, performance,
    MessageChannel, requestAnimationFrame: (f) => setTimeout(f, 0), Map, Set, Promise,
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
assert.match(ambiguous.why, /2 fields on this page share the label "Other"/);
assert.equal(G.locate({ field_key: "question_12", label: "Other" }), null);
assert.equal(JSON.stringify(G.locateWithReason({ field_key: "question_13", label: "Nothing here" })), JSON.stringify({ el: null }), "no match is silent: 'not on page'");
// Two labels pointing at the same control are one match.
const twice = load(documentOf([
  el("label", { text: "City", attrs: { for: "c" } }), el("label", { text: "City", attrs: { for: "c" } }), el("input", { id: "c", type: "text" }),
]));
assert.equal(twice.locate({ field_key: "q", label: "City" }).id, "c");

console.log("fill.test.mjs: all assertions passed");
