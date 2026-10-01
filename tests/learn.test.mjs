// node tests/learn.test.mjs — the emission rule and the value reader, with a
// stub DOM small enough to read. No browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

function el(tag, props = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), children, attributes: {}, type: props.type || "", id: props.id || "", name: props.name || "",
    value: props.value !== undefined ? props.value : "", checked: !!props.checked, multiple: !!props.multiple,
    className: props.className || "", innerText: props.text || "", textContent: props.text || "", options: props.options || [],
    selectedOptions: props.selectedOptions || [], parentElement: null,
    getAttribute(n) { return n in this.attributes ? this.attributes[n] : (n === "role" ? (props.role || null) : null); },
    hasAttribute(n) { return n in this.attributes; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return all(this).filter((c) => matches(c, sel)); },
    closest() { return null; }, contains(x) { return all(this).includes(x); },
  };
  if (props.role) node.attributes.role = props.role;
  for (const [k, v] of Object.entries(props.attrs || {})) node.attributes[k] = v;
  for (const c of children) c.parentElement = node;
  return node;
}
function all(node) { const out = []; for (const c of node.children || []) { out.push(c, ...all(c)); } return out; }
function matches(node, selector) {
  // just enough: comma lists of  tag[type="x"], button[aria-pressed="true"], input:not([type="hidden"]), [role="combobox"], [class*="x"]
  return selector.split(",").some((part) => {
    part = part.trim();
    const tag = (part.match(/^[a-z]+/i) || [""])[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const m of part.matchAll(/\[([a-z-]+)(?:([*]?=)"([^"]*)")?\]/g)) {
      const [, attr, op, val] = m;
      const actual = attr === "type" ? node.type : attr === "class" ? node.className : node.getAttribute(attr);
      if (op === undefined) { if (actual == null) return false; }
      else if (op === "=") { if (actual !== val) return false; }
      else if (op === "*=") { if (!(actual || "").includes(val)) return false; }
    }
    for (const m of part.matchAll(/:not\(\[([a-z-]+)="([^"]*)"\]\)/g)) {
      const actual = m[1] === "type" ? node.type : node.getAttribute(m[1]);
      if (actual === m[2]) return false;
    }
    return true;
  });
}

const doc = el("document");
const sandbox = {
  FirstPlay: { locate: () => null, displayedValue: () => null },
  document: Object.assign(doc, { documentElement: { getAttribute: () => null, setAttribute() {} }, activeElement: null, addEventListener() {} }),
  console, CSS: { escape: (s) => s }, chrome: { runtime: { sendMessage: async () => ({ ok: true }) } },
  setTimeout, clearTimeout, performance,
};
vm.runInNewContext(readFileSync(new URL("../src/learn.js", import.meta.url), "utf8"), sandbox);
const L = sandbox.FirstPlay._learn;
// Objects cross the vm realm with a different prototype; compare by shape.
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// --- the emission rule
const review = { field_key: "q1", label: "Desired salary", value: null, values: [], needs_review: true, reason: "nothing stored answers this yet", source: "human" };
const filled = { field_key: "q2", label: "Phone", value: "301-555-0100", values: [], needs_review: false, reason: "stored as phone", source: "memory" };
const skipped = { field_key: "q3", label: "Website", value: null, values: [], needs_review: false, skipped: "you always skip website", reason: "you always skip website", source: "memory" };
assert.deepEqual(L.decide(review, "Open to the posted range", undefined).emit, true, "an answer to a review field is observed");
assert.equal(L.decide(review, "   ", undefined).emit, false, "an empty value is not");
assert.equal(L.decide(filled, "301-555-0100", undefined).emit, false, "the plan's own value is not an observation");
assert.equal(L.decide(filled, "(301) 555-0199", undefined).emit, true, "a correction is");
assert.equal(L.decide(skipped, "https://ada.dev", undefined).emit, true, "an answer to a skipped field is");
assert.equal(L.decide(review, "Open to the posted range", "open to the posted range").emit, false, "sent once, not again");
assert.equal(L.decide({ ...review, field_key: "demographic_answers.1" }, "x").emit, false, "protected keys never");
assert.equal(L.decide({ ...review, field_key: "d5e6e981__systemfield_eeoc_gender" }, "x").emit, false, "Ashby EEOC never");
assert.equal(L.decide({ ...review, reason: "this question is only ever answered by you" }, "I Agree").emit, false, "consents never");
assert.equal(L.decide({ ...review, reason: "set consents.sms_messages once to answer this every time" }, "Yes").emit, false, "unset consents never");
assert.equal(L.decide({ ...review, reason: "answer once during onboarding, then reused" }, "No").emit, false, "unstored protected never");
assert.equal(L.decide({ ...review, attach: "resume" }, "cv.pdf").emit, false, "attachments never");
assert.deepEqual(L.decide({ ...review, values: [], value: null }, ["New York, NY", "Remote"], undefined).emit, true, "a multi-select answer");
assert.equal(L.decide({ ...filled, values: ["A", "B"], value: null }, ["A", "B"], undefined).emit, false, "a multi-select equal to the plan is not");

// --- the value reader
const text = el("input", { type: "text", value: "Open to the posted range" });
same(L.readValue(text), { value: "Open to the posted range", kind: "text", options: [] });
assert.equal(L.readValue(el("input", { type: "file", value: "C:\\fakepath\\cv.pdf" })).value, undefined, "files are never read");
assert.equal(L.readValue(el("input", { type: "password", value: "hunter2" })).value, undefined, "passwords never");
const area = el("textarea", { value: "a few lines" });
assert.equal(L.readValue(area).kind, "long_text");
const optA = { value: "a", textContent: "Alpha" }, optB = { value: "b", textContent: "Beta" }, blank = { value: "", textContent: "Select..." };
const select = el("select", { options: [blank, optA, optB], selectedOptions: [optB] });
same(L.readValue(select), { value: "Beta", kind: "single_select", options: ["Alpha", "Beta"] });
const yes = el("button", { text: "Yes", attrs: { "aria-pressed": "false" } });
const no = el("button", { text: "No", attrs: { "aria-pressed": "true" } });
const yn = el("div", { attrs: { "data-field-path": "abc" } }, [el("input", { type: "checkbox" }), yes, no]);
same(L.readValue(yn), { value: "No", kind: "boolean", options: ["Yes", "No"] }, "Ashby yes/no reads the pressed button");
const lone = el("div", { attrs: { "data-field-path": "def" } }, [el("input", { type: "checkbox", checked: true })]);
assert.equal(L.readValue(lone).value, "Yes");
const combo = el("input", { type: "text", role: "combobox", value: "Ithaca, New York, United States" });
assert.equal(L.readValue(combo).value, "Ithaca, New York, United States", "an autocomplete's text is its value");

console.log("learn.test.mjs: all assertions passed");
