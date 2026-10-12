// node tests/content.test.mjs — the parts of content.js that shape what is
// stored or crosses a boundary: the misses log row (no values, audit F6)
// and the page-world plan. The real fill.js produces the reasons, under the
// same stub DOM as fill.test.mjs. No browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { el, documentOf } from "./stub_dom.mjs";

function load(doc) {
  const sandbox = {
    document: doc, console, CSS: { escape: (s) => s }, setTimeout, clearTimeout, setInterval: () => 0, performance,
    MessageChannel, requestAnimationFrame: (f) => setTimeout(f, 0), Map, Set, Promise,
    HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
    window: { location: { host: "example.test", pathname: "/", search: "" } },
    location: { host: "example.test", pathname: "/" },
    chrome: { runtime: { getManifest: () => ({ version: "test" }), sendMessage: async () => ({ ok: true }) },
              storage: { local: { get: async () => ({}), set: async () => {} } } },
  };
  sandbox.window.top = sandbox.window;
  vm.runInNewContext(readFileSync(new URL("../src/fill.js", import.meta.url), "utf8"), sandbox);
  // content.js auto-runs; with no detectPosting result it logs and returns.
  sandbox.FirstPlay.detectPosting = () => null;
  vm.runInNewContext(readFileSync(new URL("../src/content.js", import.meta.url), "utf8"), sandbox);
  return sandbox.FirstPlay;
}

// --- the misses row carries no value, whichever driver refused it (p03 shape)
const fieldset = el("fieldset", { id: "question_5" }, [
  el("input", { id: "r1", type: "radio", name: "question_5" }), el("label", { text: "Alpha", attrs: { for: "r1" } }),
  el("input", { id: "r2", type: "radio", name: "question_5" }), el("label", { text: "Beta", attrs: { for: "r2" } }),
]);
const F = load(documentOf([fieldset]));
const SECRET = "Ithaca Office Secret";
const plan = { entries: [{ field_key: "question_5", label: "Which office?", value: SECRET, values: [], needs_review: false,
  source: "memory", reason: "stored as office_preference" }] };
const outcome = await F.applyPlan(plan, {});
const d = outcome.details[0];
assert.equal(d.state, "failed");
assert.ok(d.why.includes(SECRET), "the page-side detail still names the value (it is shown beside the field)");
const row = F._content.missRow(d, { ats: "greenhouse" }, "example.test/jobs/1");
assert.equal(row.why.includes(SECRET), false, "the stored misses row does not");
assert.equal(row.why, 'no choice is exactly "…"; offered: Alpha | Beta');
assert.deepEqual(Object.keys(row).sort(), ["at", "ats", "label", "state", "title", "version", "where", "why"]);
assert.equal("value" in row, false);

// A backend reason in Python's single quotes, and a mismatch row.
const single = F._content.missRow({ label: "Location", state: "mismatch", why: "this is a yes/no question; 'Ithaca, NY' is not an answer to it" }, { ats: "ashby" }, "x");
assert.equal(single.why, "this is a yes/no question; '…' is not an answer to it");
const offered = F._content.missRow({ label: "Location", state: "mismatch",
  why: `the form's suggestions do not include ${JSON.stringify("Ithaca, NY")}; offered: Netherlands | New Zealand` }, { ats: "ashby" }, "x");
assert.equal(offered.why.includes("Ithaca"), false);
assert.equal(F._content.missRow({ label: "x", state: "failed" }, { ats: "ashby" }, "x").why, "", "no reason is an empty string, not undefined");

// --- the page-world plan: entries the fill will not write cross without their values
const page = F._content.pagePlanFor({ entries: [
  { field_key: "a", value: "write me", values: [], needs_review: false },
  { field_key: "b", value: "never approved", values: [], needs_review: true, reason: "'never approved' is not an answer", needs_fact: { key: "k" } },
  { field_key: "c", value: "leftover", values: [], skipped: "you skip this" },
] });
assert.equal(page.entries[0].value, "write me");
assert.equal(page.entries[1].value, null);
assert.equal(page.entries[1].needs_fact, null);
assert.equal(page.entries[1].reason.includes("never approved"), false);
assert.equal(page.entries[2].value, null);

console.log("content.test.mjs: all assertions passed");
