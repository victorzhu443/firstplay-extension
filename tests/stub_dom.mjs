// A DOM stub small enough to read, for loading the classic scripts under
// node. Just enough of querySelector(All), getElementById, closest and
// attributes for the pure paths the tests exercise. No browser.

export function el(tag, props = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), children, attributes: {}, type: props.type || "", id: props.id || "", name: props.name || "",
    value: props.value !== undefined ? props.value : "", checked: !!props.checked, multiple: !!props.multiple,
    className: props.className || "", innerText: props.text || "", textContent: props.text || "", options: props.options || [],
    selectedOptions: props.selectedOptions || [], parentElement: null, tabIndex: 0, offsetParent: {}, dataset: {}, style: {},
    getAttribute(n) { return n in this.attributes ? this.attributes[n] : (n === "role" ? (props.role || null) : null); },
    hasAttribute(n) { return n in this.attributes; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { return all(this).filter((c) => matches(c, sel)); },
    closest(sel) { let n = this; while (n) { if (n.tagName !== "DOCUMENT" && matches(n, sel)) return n; n = n.parentElement; } return null; },
    contains(x) { return all(this).includes(x); },
    matches(sel) { return matches(this, sel); },
    // The drivers click and dispatch; a test overrides `click` on the nodes
    // whose click should do something (a day cell, a nav button).
    focus() {}, blur() {},
    dispatchEvent() { return true; },
    click() { if (this.type === "checkbox") this.checked = !this.checked; else if (this.type === "radio") this.checked = true; },
  };
  if (props.role) node.attributes.role = props.role;
  if (props.id) node.attributes.id = props.id;
  if (props.name) node.attributes.name = props.name;
  for (const [k, v] of Object.entries(props.attrs || {})) node.attributes[k] = v;
  for (const c of children) c.parentElement = node;
  return node;
}

export function all(node) { const out = []; for (const c of node.children || []) { out.push(c, ...all(c)); } return out; }

export function matches(node, selector) {
  // just enough: comma lists of  tag[type="x"], [attr="x"], [attr*="x"], [attr^="x"], [attr$="x"], tag:not([type="hidden"])
  return selector.split(",").some((part) => {
    part = part.trim();
    const tag = (part.match(/^[a-z][a-z0-9]*/i) || [""])[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    // Class selectors match on className, not on everything (a bare ".select__input"
    // once matched every element, which would call every input a react-select).
    for (const m of part.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      if (!String(node.className || "").split(/\s+/).includes(m[1])) return false;
    }
    const attrOf = (attr) => (attr === "type" ? node.type : attr === "class" ? node.className : node.getAttribute(attr));
    // Attribute values may be quoted either way ([class*='input-yesno'] in fill.js);
    // a [type="hidden"] inside :not(...) is a negative condition, not a positive one.
    const positive = part.replace(/:not\([^)]*\)/g, "");
    for (const m of positive.matchAll(/\[([a-z-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'))?\]/g)) {
      const [, attr, op] = m;
      const val = m[3] !== undefined ? m[3] : m[4];
      const actual = attrOf(attr);
      if (op === undefined) { if (actual == null) return false; }
      else if (op === "=") { if (actual !== val) return false; }
      else if (op === "*=") { if (!(actual || "").includes(val)) return false; }
      else if (op === "^=") { if (!(actual || "").startsWith(val)) return false; }
      else if (op === "$=") { if (!(actual || "").endsWith(val)) return false; }
    }
    for (const m of part.matchAll(/:not\(\[([a-z-]+)=(?:"([^"]*)"|'([^']*)')\]\)/g)) {
      if (attrOf(m[1]) === (m[2] !== undefined ? m[2] : m[3])) return false;
    }
    return true;
  });
}

/** A document holding `children`, with getElementById over the whole tree. */
export function documentOf(children = []) {
  const doc = el("document", {}, children);
  doc.getElementById = (id) => all(doc).find((n) => n.id === id) || null;
  doc.documentElement = { getAttribute: () => null, setAttribute() {} };
  doc.visibilityState = "visible";
  doc.hidden = false;
  doc.activeElement = null;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.body = doc;
  return doc;
}
