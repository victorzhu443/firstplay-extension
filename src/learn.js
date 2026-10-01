/**
 * Learning capture: what the applicant does to the form after the fill.
 *
 * The plan is the tool's answer; what the applicant types, picks and
 * corrects before pressing Submit is the ground truth the tool lacked. This
 * script watches the controls the plan knows, and when the applicant's value
 * differs from the plan's — or the plan had nothing — it sends that one
 * observation (question, options, the plan's value, the applicant's value)
 * to the local backend, which decides what it means (an answer to replay,
 * a fact to propose) and hands back the profile to store. Nothing here
 * decides; nothing here submits; nothing leaves the machine.
 *
 * Classic script, same isolated world as content.js; fill.js's `locate`
 * and `displayedValue` are on the same namespace.
 */
(function (ns) {
  "use strict";

  const TAG = "[FirstPlay]";

  //: Field keys and plan reasons that are never observed. Protected
  //: characteristics and consents are answered by the applicant, not learned
  //: from them (the backend filters the same way; both sides, on purpose).
  const PROTECTED_KEY = /_systemfield_eeoc|^demographic_answers\.|^(veteran_status|disability|disability_status|race|gender|hispanic_ethnicity)$/i;
  const PROTECTED_REASON = /answer once during onboarding/i;
  const CONSENT_REASON = /only ever answered by you|consents\.|you decline |could not tell which option means/i;

  function normalise(value) {
    const text = Array.isArray(value) ? value.join(" | ") : String(value == null ? "" : value);
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  /** The plan's value for an entry, as a string or list, or null. */
  function planValue(entry) {
    if (entry.values && entry.values.length) return entry.values.slice();
    return entry.value == null || entry.value === "" ? null : String(entry.value);
  }

  /** Whether the plan left this entry to the applicant. */
  function wasForApplicant(entry) {
    if (entry.skipped || entry.needs_review) return true;
    return entry.value == null && !(entry.values && entry.values.length);
  }

  /** Whether an entry is one the capture may ever report. */
  function observable(entry) {
    if (!entry || !entry.field_key || entry.attach || entry.satisfied_by) return false;
    if (PROTECTED_KEY.test(entry.field_key)) return false;
    const reason = entry.reason || "";
    if (PROTECTED_REASON.test(reason) || CONSENT_REASON.test(reason)) return false;
    return true;
  }

  /**
   * The emission rule, pure so it can be tested without a DOM: an
   * observation is worth sending when the applicant's value is non-empty,
   * not what was last sent, and either the plan had nothing for the field or
   * the value differs from the plan's.
   */
  function decide(entry, userValue, lastSent) {
    if (!observable(entry)) return { emit: false, why: "never observed" };
    const user = normalise(userValue);
    if (!user) return { emit: false, why: "empty" };
    if (lastSent !== undefined && lastSent === user) return { emit: false, why: "already sent" };
    const plan = normalise(planValue(entry));
    if (!wasForApplicant(entry) && plan === user) return { emit: false, why: "same as plan" };
    return { emit: true, why: wasForApplicant(entry) ? "applicant answered" : "applicant corrected" };
  }

  // ----- reading the page ---------------------------------------------------

  function labelText(input) {
    const byFor = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    const label = byFor || input.closest("label");
    return label ? label.innerText.replace(/\s+/g, " ").trim() : (input.value || "");
  }

  function isYesNoContainer(el) {
    return !!el.querySelector && !!el.querySelector('button[aria-pressed]');
  }

  /** The applicant's current value for a located control, the way the dry run reads values back. */
  function readValue(el) {
    if (!el) return { value: null, kind: null, options: [] };
    const tag = el.tagName;
    const type = (el.type || "").toLowerCase();

    if (tag === "FIELDSET" || el.hasAttribute("data-field-path")) {
      if (isYesNoContainer(el)) {
        const pressed = el.querySelector('button[aria-pressed="true"]');
        return { value: pressed ? pressed.textContent.trim() : null, kind: "boolean", options: ["Yes", "No"] };
      }
      const radios = Array.from(el.querySelectorAll('input[type="radio"]'));
      if (radios.length) {
        const on = radios.find((r) => r.checked);
        return { value: on ? labelText(on) : null, kind: "single_select", options: radios.map(labelText) };
      }
      const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]'));
      if (boxes.length > 1) {
        return { value: boxes.filter((b) => b.checked).map(labelText), kind: "multi_select", options: boxes.map(labelText) };
      }
      if (boxes.length === 1) return { value: boxes[0].checked ? "Yes" : null, kind: "boolean", options: ["Yes", "No"] };
      const inner = el.querySelector('input:not([type="hidden"]), textarea, select, [role="combobox"]');
      return inner ? readValue(inner) : { value: null, kind: null, options: [] };
    }

    if (tag === "SELECT") {
      const chosen = Array.from(el.selectedOptions || []).filter((o) => o.value !== "");
      const options = Array.from(el.options || []).filter((o) => o.value !== "").map((o) => o.textContent.trim());
      if (el.multiple) return { value: chosen.map((o) => o.textContent.trim()), kind: "multi_select", options };
      return { value: chosen.length ? chosen[0].textContent.trim() : null, kind: "single_select", options };
    }

    if (tag === "TEXTAREA") return { value: el.value, kind: "long_text", options: [] };

    if (tag === "INPUT") {
      if (type === "file" || type === "password" || type === "hidden" || type === "submit" || type === "button") {
        return { value: undefined, kind: null, options: [] };
      }
      if (type === "radio") {
        const group = el.name ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)) : [el];
        const on = group.find((r) => r.checked);
        return { value: on ? labelText(on) : null, kind: "single_select", options: group.map(labelText) };
      }
      if (type === "checkbox") {
        const group = el.name ? Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`)) : [el];
        if (group.length > 1) return { value: group.filter((b) => b.checked).map(labelText), kind: "multi_select", options: group.map(labelText) };
        return { value: el.checked ? "Yes" : null, kind: "boolean", options: ["Yes", "No"] };
      }
      const reactish = el.getAttribute("role") === "combobox" || (el.className || "").includes("select__input");
      if (reactish) {
        const shown = ns.displayedValue ? ns.displayedValue(el) : null;
        const container = el.closest(".select__container") || el.parentElement;
        const multi = container && Array.from(container.querySelectorAll('[class*="multi-value__label"]')).map((m) => m.textContent.trim());
        if (multi && multi.length) return { value: multi, kind: "multi_select", options: [] };
        return { value: shown || el.value || null, kind: "single_select", options: [] };
      }
      const kind = ({ number: "number", date: "date", email: "email", tel: "phone", url: "url" })[type] || "text";
      return { value: el.value, kind, options: [] };
    }

    return { value: null, kind: null, options: [] };
  }

  // ----- the watch -----------------------------------------------------------

  let watch = null;

  function controlIsBeingTyped(el) {
    const active = document.activeElement;
    if (!active || !el) return false;
    if (active === el) return true;
    return !!(el.contains && el.contains(active));
  }

  function collect(final) {
    const observations = [];
    for (const entry of watch.plan.entries) {
      if (!observable(entry)) continue;
      let el;
      try { el = ns.locate(entry); } catch (_e) { el = null; }
      if (!el) continue;
      if (!final && controlIsBeingTyped(el)) continue;
      const read = readValue(el);
      if (read.value === undefined) continue;
      const verdict = decide(entry, read.value, watch.lastSent.get(entry.field_key));
      if (!verdict.emit) continue;
      observations.push({
        ats: watch.posting.ats,
        company: watch.plan.company || watch.posting.board || watch.posting.org || null,
        posting_id: String(watch.posting.jobId || watch.posting.postingId || watch.plan.posting_id || ""),
        field_key: entry.field_key,
        label: entry.label || "",
        kind: read.kind,
        options: (read.options || []).slice(0, 60),
        required: !!entry.required,
        plan_value: planValue(entry),
        plan_source: entry.source || null,
        user_value: read.value,
        at: new Date().toISOString(),
      });
      watch.lastSent.set(entry.field_key, normalise(read.value));
    }
    return observations;
  }

  function noteOnRecord(count) {
    try {
      const raw = document.documentElement.getAttribute("data-firstplay-outcome");
      const record = raw ? JSON.parse(raw) : {};
      record.learned_sent = (record.learned_sent || 0) + count;
      document.documentElement.setAttribute("data-firstplay-outcome", JSON.stringify(record));
    } catch (_e) { /* the record is a convenience */ }
  }

  function flush(final) {
    if (!watch) return Promise.resolve(0);
    let observations;
    try { observations = collect(final); } catch (e) { console.warn(`${TAG} learning capture failed: ${e && e.message}`); return Promise.resolve(0); }
    if (!observations.length) return Promise.resolve(0);
    noteOnRecord(observations.length);
    console.log(`${TAG} learning: ${observations.length} answer(s) of yours sent to your local backend`);
    return chrome.runtime.sendMessage({ kind: "learn", observations })
      .then((r) => {
        if (r && r.ok) {
          const bits = [`${r.learned || 0} remembered`];
          if (r.proposals) bits.push(`${r.proposals} new fact(s) proposed — see the extension popup`);
          console.log(`${TAG} learning: ${bits.join(", ")}`);
        } else if (r && r.why) {
          console.log(`${TAG} learning: not recorded (${r.why})`);
        }
        return observations.length;
      })
      .catch(() => observations.length);
  }

  function schedule(ms) {
    if (!watch) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => flush(false), ms);
  }

  function isSubmitControl(target) {
    const button = target && target.closest && target.closest('button, input[type="submit"]');
    if (!button) return false;
    if ((button.type || "").toLowerCase() === "submit") return true;
    return /submit application|^submit$/i.test((button.innerText || button.value || "").trim());
  }

  /**
   * Start watching this plan's controls. Idempotent per page: a second plan
   * (Ashby's posting → /application move, a popup re-run) replaces the first.
   */
  function watchForLearning(posting, plan) {
    if (!plan || !plan.entries) return;
    if (watch) { clearTimeout(watch.timer); }
    const first = !watch;
    watch = { posting, plan, lastSent: new Map(), timer: null };
    if (!first) return;

    // Capture-phase listeners, never preventing anything. A change (text
    // blur, select pick, radio) schedules a short flush; keystrokes a longer
    // one so a half-typed answer is not reported.
    document.addEventListener("change", () => schedule(1500), true);
    document.addEventListener("input", () => schedule(4000), true);
    document.addEventListener("click", (event) => { if (isSubmitControl(event.target)) flush(true); }, true);
    document.addEventListener("pagehide", () => flush(true));
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(true); });
  }

  ns.watchForLearning = watchForLearning;
  ns.flushLearning = () => flush(true);
  // Pure pieces, for tests.
  ns._learn = { decide, observable, planValue, wasForApplicant, normalise, readValue };
})(FirstPlay);
