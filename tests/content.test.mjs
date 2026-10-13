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

// --- the Greenhouse required check: plan flags plus the DOM's own signals, no Submit click (audit F4)
function loadWithLearn(doc) {
  const sandbox = {
    document: doc, console, CSS: { escape: (s) => s }, setTimeout, clearTimeout, setInterval: () => 0, performance,
    MessageChannel, requestAnimationFrame: (f) => setTimeout(f, 0), Map, Set, Promise,
    HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
    window: { location: { host: "job-boards.greenhouse.io", pathname: "/acme/jobs/1", search: "" } },
    location: { host: "job-boards.greenhouse.io", pathname: "/acme/jobs/1" },
    chrome: { runtime: { getManifest: () => ({ version: "test" }), sendMessage: async () => ({ ok: true }) },
              storage: { local: { get: async () => ({}), set: async () => {} } } },
  };
  sandbox.window.top = sandbox.window;
  for (const f of ["fill.js", "learn.js"]) vm.runInNewContext(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"), sandbox);
  sandbox.FirstPlay.detectPosting = () => null;
  sandbox.FirstPlay.atsOfHost = () => null;
  vm.runInNewContext(readFileSync(new URL("../src/content.js", import.meta.url), "utf8"), sandbox);
  return sandbox.FirstPlay;
}
const decoy = el("input", { id: "decoy", type: "text", attrs: { "aria-required": "true" } }); decoy.offsetParent = null;
// react-select's required decoy: visible to offsetParent, opacity 0, tabindex -1, no label, `required` set.
const rsDecoy = el("input", { type: "text", className: "remix-css-1a0ro4n-requiredInput", attrs: { required: "", tabindex: "-1" } }); rsDecoy.tabIndex = -1;
const gh = documentOf([
  el("label", { text: "First Name*", attrs: { for: "first_name" } }), el("input", { id: "first_name", type: "text" }),
  el("label", { text: "Email*", attrs: { for: "email" } }), el("input", { id: "email", type: "email", value: "ada@example.com", attrs: { required: "" } }),
  el("label", { text: "Phone", attrs: { for: "phone" } }), el("input", { id: "phone", type: "tel" }),
  el("label", { text: "LinkedIn", attrs: { for: "linkedin" } }), el("input", { id: "linkedin", type: "url" }),
  el("label", { text: "Gender", attrs: { for: "gender" } }),
  el("input", { id: "gender", type: "text", role: "combobox", attrs: { "aria-invalid": "true", "aria-describedby": "gender-err" } }),
  el("div", { id: "gender-err", text: "Please select an option" }),
  el("label", { text: "Resume/CV*", attrs: { for: "resume" } }), el("input", { id: "resume", type: "file" }),
  el("fieldset", { id: "question_9" }, [
    el("legend", { text: "Office?*" }),
    el("input", { id: "o1", type: "radio", name: "question_9", attrs: { "aria-required": "true" } }), el("label", { text: "Ithaca", attrs: { for: "o1" } }),
    el("input", { id: "o2", type: "radio", name: "question_9", attrs: { "aria-required": "true" } }), el("label", { text: "Remote", attrs: { for: "o2" } }),
  ]),
  decoy,
  rsDecoy,
]);
const G = loadWithLearn(gh);
const check = G._content.domRequiredCheck({ entries: [
  { field_key: "first_name", label: "First Name", value: "Ada", values: [], required: true },
  { field_key: "email", label: "Email", value: "ada@example.com", values: [], required: true },
  { field_key: "phone", label: "Phone", value: null, values: [], needs_review: true, required: true },
  { field_key: "linkedin", label: "LinkedIn", value: null, values: [], needs_review: true, required: false },
  { field_key: "gender", label: "Gender", value: "Decline", values: [], required: false },
  { field_key: "resume", label: "Resume/CV", value: null, values: [], attach: "resume", required: true },
  { field_key: "cover_letter", label: "Cover Letter", value: null, values: [], skipped: "you skip this", required: true },
] });
assert.equal(check.ok, true);
assert.equal(JSON.stringify(check.blocked), "[]", "nothing was clicked, so nothing was blocked");
assert.equal(check.submitButton, "(not clicked)");
const wanted = Object.fromEntries(check.invalid.map((r) => [r.id, r.message]));
assert.match(wanted.first_name, /required \(plan, \* label\)/, "empty, required by the plan and the * convention");
assert.equal("email" in wanted, false, "a filled required field is not wanted");
assert.match(wanted.phone, /required \(plan\)/, "the plan's flag alone is a signal");
assert.equal("linkedin" in wanted, false, "an empty optional field is not wanted");
assert.equal(wanted.gender, "invalid: Please select an option", "an aria-invalid the form already set is reported with its message");
assert.match(wanted.resume, /required \(plan, \* label\)/, "a file input with no file");
assert.match(wanted.question_9, /required \(required, \* label\)/, "a radio group the plan did not know, once");
assert.equal(check.invalid.filter((r) => r.id === "question_9").length, 1);
assert.equal(check.invalid.some((r) => /^INPUT$/.test(r.label || "") || r.id === ""), false,
  "react-select's required decoy is not a wanted field (live: General Matter x3, Bitmovin x1 on 0.4.52)");
assert.equal("decoy" in wanted, false, "an invisible input is nobody's");
assert.equal("cover_letter" in wanted, false, "a skipped entry is not wanted");
assert.equal(check.invalid.length, 5, JSON.stringify(check.invalid));
for (const r of check.invalid) assert.equal(JSON.stringify(Object.keys(r).sort()), JSON.stringify(["id", "label", "message", "name"]));
assert.equal(check.invalid.find((r) => r.id === "first_name").label, "First Name", "the * is stripped from the label");

console.log("content.test.mjs (F4): all assertions passed");

// --- choice groups in the DOM check: Greenhouse's `question_N-labeled-checkbox-K` inputs are the
// plan's `question_N`, one control however many boxes, holding a value when any box is checked
// (R50: consents "not in plan" on Signifyd, Attentive, InternshipList; Rugged Robotics' multi-
// checkbox group "plan said FILL but form still wants").
function choicePage() {
  const consentLabel = "By checking this box, I consent to being contacted about this application";
  const q7 = el("div", {}, [
    el("label", { text: `${consentLabel} *` }),
    el("input", { id: "question_7-labeled-checkbox-0", type: "checkbox", attrs: { "aria-required": "true" } }),
    el("label", { text: "I consent", attrs: { for: "question_7-labeled-checkbox-0" } }),
  ]);
  const q8 = el("div", {}, [
    el("label", { text: "Are you interested in a Spring Co-Op, Summer Internship, or Fall Co-Op? *" }),
    el("input", { id: "question_8-labeled-checkbox-0", type: "checkbox", attrs: { "aria-required": "true" } }), el("label", { text: "Spring Co-Op", attrs: { for: "question_8-labeled-checkbox-0" } }),
    el("input", { id: "question_8-labeled-checkbox-1", type: "checkbox", attrs: { "aria-required": "true" } }), el("label", { text: "Summer Internship", attrs: { for: "question_8-labeled-checkbox-1" } }),
    el("input", { id: "question_8-labeled-checkbox-2", type: "checkbox", attrs: { "aria-required": "true" } }), el("label", { text: "Fall Co-Op", attrs: { for: "question_8-labeled-checkbox-2" } }),
  ]);
  const doc = documentOf([el("label", { text: "First Name *", attrs: { for: "first_name" } }), el("input", { id: "first_name", type: "text", value: "Ada" }), q7, q8]);
  const plan = { entries: [
    { field_key: "first_name", label: "First Name", value: "Ada", values: [], required: true },
    { field_key: "question_7", label: consentLabel, value: "I consent", values: [], needs_review: false, required: true, source: "memory", reason: "consents.contact" },
    { field_key: "question_8", label: "Are you interested in a Spring Co-Op, Summer Internship, or Fall Co-Op?", value: null, values: ["Summer Internship"], needs_review: false, required: true, source: "memory", reason: "stored as term_preference" },
  ] };
  return { doc, plan, boxes: (prefix) => doc.querySelectorAll(`input[id^="${prefix}-"]`) };
}
{
  // Before any fill: both groups are wanted, once each, under the plan's keys and labels.
  const page = choicePage();
  const C = loadWithLearn(page.doc);
  const before = C._content.domRequiredCheck(page.plan);
  const ids = (check) => JSON.stringify(check.invalid.map((r) => r.id));
  assert.equal(ids(before), '["question_7","question_8"]', JSON.stringify(before.invalid));
  assert.equal(before.invalid[0].label.startsWith("By checking this box, I consent"), true, "the question, not the box's own 'I consent'");
  assert.equal(before.invalid[1].label.startsWith("Are you interested in a Spring Co-Op"), true);
  assert.equal(before.invalid.some((r) => /-labeled-/.test(r.id)), false, "no option-input id reaches the rows");
  // The second box ticked by hand: the multi-checkbox group holds a value.
  page.boxes("question_8")[1].checked = true;
  assert.equal(ids(C._content.domRequiredCheck(page.plan)), '["question_7"]', "any checked box answers a group");
}
{
  // The real fill: the lone consent box is ticked by its own label, the group by the option; then nothing is wanted.
  const page = choicePage();
  const C = loadWithLearn(page.doc);
  const outcome = await C.applyPlan({ entries: page.plan.entries.slice(1) }, {});   // the stub has no native setter for the text field
  assert.equal(outcome.filled, 2, JSON.stringify(outcome.details));
  assert.equal(outcome.failed + outcome.missing, 0, JSON.stringify(outcome.details));
  assert.equal(page.boxes("question_7")[0].checked, true);
  assert.equal(JSON.stringify(Array.from(page.boxes("question_8")).map((b) => b.checked)), "[false,true,false]");
  assert.equal(JSON.stringify(C._content.domRequiredCheck(page.plan).invalid), "[]", "a filled group is not 'plan said FILL but form still wants'");
}
{
  // Groups the plan never knew: one row each, keyed by the question, never one per box.
  const page = choicePage();
  const C = loadWithLearn(page.doc);
  const rows = C._content.domRequiredCheck({ entries: [page.plan.entries[0]] }).invalid;
  assert.equal(JSON.stringify(rows.map((r) => r.id)), '["question_7","question_8"]', JSON.stringify(rows));
  assert.equal(JSON.stringify(rows.map((r) => r.name)), '["question_7","question_8"]');
}

console.log("content.test.mjs (choice groups): all assertions passed");
