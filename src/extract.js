/**
 * Reading an application form out of the page.
 *
 * Runs in the page context, so it must not assume any framework. Two facts
 * about real ATS forms shape it, both established by reading live pages rather
 * than guessed:
 *
 *   1. Radio inputs sharing a `name` are ONE question. Each input is labelled
 *      with its own *option* ("Hispanic or Latino"), not with the question, and
 *      real Ashby forms carry no fieldset legend at all — so reading them as
 *      separate fields turns one protected-characteristic question into eight
 *      fields whose labels match no sensitive-wording pattern.
 *
 *   2. Checkboxes are NOT the same case. "How did you hear about us?" renders
 *      as independent checkboxes with *different* names, so grouping them would
 *      merge genuinely separate fields.
 *
 * Nothing here interprets anything. It reports what is on the page.
 *
 * Written as a classic script attaching to one global, not an ES module.
 * Declared content scripts in MV3 are always classic scripts, so an `export`
 * here is a syntax error at load time and the whole script silently never
 * runs — a failure that looks exactly like the extension not being installed.
 * Only the service worker may be a module.
 */
var FirstPlay = FirstPlay || {};

(function (ns) {
  "use strict";

  /** Best available label for a control, in order of reliability. */
  function labelFor(el) {
  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit) return explicit.innerText.trim();
  }

  const wrapping = el.closest("label");
  if (wrapping) return wrapping.innerText.trim();

  const fieldset = el.closest("fieldset");
  const legend = fieldset && fieldset.querySelector("legend");
  if (legend) return legend.innerText.trim();

  const group = el.closest('[role="radiogroup"],[role="group"]');
  if (group) {
    const aria = group.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = group.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target) return target.innerText.trim();
    }
  }

  const aria = (el.getAttribute("aria-label") || "").trim();
  if (aria) return aria;

  return containerLabel(el);
  }

  /**
   * Ashby's field container. Measured on three live SWE-intern forms (Notion
   * x2, Perplexity, 2026-09-27): every question sits in a
   * `div[class*="fieldEntry"]` whose first <label> is the question text. For
   * text inputs that label also has a matching `for`; for radio and checkbox
   * groups it is the ONLY place the question text exists (no fieldset, no
   * legend); and for the Location combobox its `for` names a field id
   * (`_systemfield_location`) that no element carries.
   */
  function fieldContainer(el) {
  return el.closest('[class*="fieldEntry"], [class*="field-entry"]');
  }

  function containerLabel(el) {
  const container = fieldContainer(el);
  const label = container && container.querySelector("label");
  return label ? label.innerText.trim() : "";
  }

  /** The `for` of a container label when nothing on the page carries that id. */
  function danglingFieldId(el) {
  const container = fieldContainer(el);
  const label = container && container.querySelector("label[for]");
  const forId = label && label.getAttribute("for");
  return forId && !document.getElementById(forId) ? forId : "";
  }

  function normaliseWhitespace(text) {
  return (text || "").replace(/\s+/g, " ").trim();
  }

  /** Options of a <select>, as label/value pairs. */
  function selectOptions(el) {
  return Array.from(el.options || [])
    .filter((o) => o.value !== "")
    .map((o) => ({ label: normaliseWhitespace(o.textContent), value: o.value }));
  }

  /**
   * Every answerable control on the page, with radio groups collapsed.
   *
   * @returns {Array<object>} controls in the shape the backend's Ashby adapter
   *   expects: {tag, type, name, id, required, label, options}
   */
  /**
   * Key shared by Ashby's checkbox options: ids run
   * `<form>_<question>-labeled-checkbox-0`, `-1`, … so everything before the
   * index names the question. Radios use the same scheme with `-labeled-radio-`.
   */
  function optionGroupKey(el) {
  const match = (el.id || "").match(/^(.*-labeled-(?:checkbox|radio))-\d+$/);
  return match ? match[1] : "";
  }

  function extractControls() {
  const elements = Array.from(document.querySelectorAll("input, textarea, select"));
  const radioGroups = new Map();
  const checkboxGroups = new Map();
  const controls = [];

  for (const el of elements) {
    const type = (el.type || "").toLowerCase();

    // Skip what is never an application answer.
    if (type === "hidden" || type === "submit" || type === "button") continue;
    if (el.name === "g-recaptcha-response") continue;
    // Passwords and payment fields are never read, never sent, never filled.
    if (type === "password") continue;

    const label = normaliseWhitespace(labelFor(el));
    const required = el.required || el.getAttribute("aria-required") === "true";

    if (type === "radio" && el.name) {
      let group = radioGroups.get(el.name);
      if (!group) {
        group = {
          tag: "input",
          type: "radio",
          name: el.name,
          id: el.name,
          // The question text is not on the radios themselves, whose labels
          // are option text. Ashby keeps it in the field container; when no
          // container exists this stays blank and the backend treats an
          // unreadable question as "never auto-answer" rather than guessing.
          label: normaliseWhitespace(containerLabel(el)),
          required: false,
          options: [],
        };
        radioGroups.set(el.name, group);
        controls.push(group);
      }
      group.required = group.required || required;
      group.options.push({ label, value: el.value || el.id || label });
      continue;
    }

    // A control with neither name nor id (Ashby's Location combobox) is
    // keyed by the field id its container label points at, so the backend
    // can recognise `_systemfield_location` and the filler can find it again.
    // Checkboxes that share a field container are the options of ONE
    // multi-select question — "Degree Type", "locations you would work in",
    // "how did you hear about us" — and each carries only its option text.
    // Measured on three live Ashby forms (2026-09-27): read singly, "New York,
    // NY" was matched to the applicant's location and "Billboard/Outdoor Ads"
    // to how they heard about the job. A lone checkbox in a container stays a
    // yes/no question labelled by that container.
    if (type === "checkbox") {
      const container = fieldContainer(el);
      const siblings = container ? container.querySelectorAll('input[type="checkbox"]') : [];
      if (siblings.length > 1) {
        const key = optionGroupKey(el) || `${containerLabel(el)}::checkboxes`;
        let group = checkboxGroups.get(key);
        if (!group) {
          group = {
            tag: "input",
            type: "checkbox-group",
            name: key,
            id: key,
            label: normaliseWhitespace(containerLabel(el)),
            required: false,
            options: [],
          };
          checkboxGroups.set(key, group);
          controls.push(group);
        }
        group.required = group.required || required;
        group.options.push({ label, value: el.name || el.id || label });
        continue;
      }
    }

    const fallbackId = !el.name && !el.id ? danglingFieldId(el) : "";

    controls.push({
      tag: el.tagName.toLowerCase(),
      type: el.tagName.toLowerCase() === "select" ? "select-one" : type,
      name: el.name || fallbackId,
      id: el.id || fallbackId,
      required,
      label,
      options: el.tagName.toLowerCase() === "select" ? selectOptions(el) : [],
    });
  }

  return controls;
  }

  /**
   * Which ATS a host belongs to — exactly. The two vendors' application
   * hosts by name, plus proper subdomains of their apex domains (the EU
   * boards: job-boards.eu.greenhouse.io, boards.eu.greenhouse.io). A host
   * that merely *ends with* the apex text (evilgreenhouse.io,
   * notashbyhq.com) is nobody's ATS; until 0.4.52 it was accepted, and a
   * page on it could be filled from the real board's schema (audit F3).
   * The service worker keeps the same rule in config.js (atsOfHost); the
   * node tests hold the two to the same vectors.
   */
  const GREENHOUSE_HOSTS = ["job-boards.greenhouse.io", "boards.greenhouse.io"];
  const ASHBY_HOSTS = ["jobs.ashbyhq.com"];

  function hostIs(host, names, apex) {
    host = String(host || "").toLowerCase();
    return names.includes(host) || host.endsWith("." + apex);
  }

  function atsOfHost(host) {
    if (hostIs(host, GREENHOUSE_HOSTS, "greenhouse.io")) return "greenhouse";
    if (hostIs(host, ASHBY_HOSTS, "ashbyhq.com")) return "ashby";
    return null;
  }

  /**
   * Which ATS this page belongs to, and how to identify the posting — or
   * null when this document is not on an ATS origin, whatever it carries.
   *
   * Greenhouse is reported with its board and job id because the backend can
   * then fetch the authoritative form schema from the public board API —
   * field names, types, required flags and option label/value pairs, none of
   * which have to be inferred from the DOM. Ashby's form comes from its own
   * ApiJobPosting operation (background.js), with the DOM extract as the
   * fallback.
   *
   * An employer's own careers page that embeds a Greenhouse form is NOT a
   * posting here: the form lives in a boards.greenhouse.io iframe, where the
   * copy of this script running there (all_frames) sees `/embed/job_app`
   * and fills. The third-party document itself is never filled, and nothing
   * of the applicant's goes to it (audit F3). See `embeddedHint` for what
   * the popup may say about such a page.
   *
   * @returns {object|null}
   */
  function detectPosting() {
  const { host, pathname } = window.location;
  const params = new URLSearchParams(window.location.search);
  const ats = atsOfHost(host);

  if (ats === "greenhouse") {
    const match = pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (match) return { ats: "greenhouse", board: match[1], jobId: match[2] };

    // The frame an employer's careers page embeds:
    //   boards.greenhouse.io/embed/job_app?for=<board>&token=<job id>
    // Seen from inside the frame, which is where a content script with
    // all_frames runs and where the controls actually are.
    if (pathname.startsWith("/embed/") && params.get("for") && params.get("token")) {
      return {
        ats: "greenhouse", board: params.get("for"), jobId: params.get("token"), embedded: true,
      };
    }
    return null;
  }

  if (ats === "ashby") {
    const match = pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (match) return { ats: "ashby", org: match[1], postingId: match[2] };
    return null;
  }

  return null;
  }

  /** The Greenhouse embed frame on this page, if any, by its own URL: {board, jobId} or null. */
  function embedFrameOn(doc) {
  for (const frame of doc.querySelectorAll("iframe[src]")) {
    let url;
    try { url = new URL(frame.getAttribute("src"), window.location.href); } catch (e) { continue; }
    if (atsOfHost(url.host) !== "greenhouse" || !url.pathname.startsWith("/embed/job_app")) continue;
    return { board: url.searchParams.get("for"), jobId: url.searchParams.get("token") };
  }
  return null;
  }

  /**
   * What a non-ATS page says about a Greenhouse posting it hosts — for the
   * popup to DESCRIBE before the applicant confirms a fill, never to fill
   * from. An employer page names the job in `?gh_jid=` and the board in the
   * embed script it loads (`/embed/job_board/js?for=<board>`); the form
   * itself, when present, is the `/embed/job_app` iframe. Nothing is
   * guessed: a board the page does not name stays null.
   *
   * @returns {{host: string, jobId: string|null, board: string|null, frame: object|null}|null}
   *   null on an ATS origin (detectPosting applies there).
   */
  function embeddedHint() {
  const { host } = window.location;
  if (atsOfHost(host)) return null;
  const params = new URLSearchParams(window.location.search);
  const embedScript = document.querySelector('script[src*="greenhouse.io/embed/job_board"]');
  let board = null;
  if (embedScript) {
    try {
      const url = new URL(embedScript.src, window.location.href);
      if (atsOfHost(url.host) === "greenhouse") board = url.searchParams.get("for");
    } catch (e) { /* not a URL */ }
  }
  return { host, jobId: params.get("gh_jid") || null, board, frame: embedFrameOn(document) };
  }

  ns.extractControls = extractControls;
  ns.detectPosting = detectPosting;
  ns.embeddedHint = embeddedHint;
  ns.atsOfHost = atsOfHost;
})(FirstPlay);
