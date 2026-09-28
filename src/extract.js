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
   * Which ATS this page belongs to, and how to identify the posting.
   *
   * Greenhouse is reported with its board and job id because the backend can then
   * fetch the authoritative form schema from the public board API — field names,
   * types, required flags and option label/value pairs, none of which have to be
   * inferred from the DOM. Ashby has no such API, so its DOM extract is the only
   * source.
   *
   * @returns {object|null}
   */
  function detectPosting() {
  const { host, pathname } = window.location;
  const params = new URLSearchParams(window.location.search);

  if (host.endsWith("greenhouse.io")) {
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

  // An employer's own careers page carrying a Greenhouse job:
  //   www.samsara.com/company/careers/roles/8082091?gh_jid=8082091
  // The URL names the job but not the board. The embed script the page loads
  // names it exactly (`/embed/job_board/js?for=<board>`); failing that, the
  // employer's second-level domain is the usual token. A guess is marked so
  // the service worker can verify it against the board API before trusting it.
  const ghJid = params.get("gh_jid");
  if (ghJid) {
    const embedScript = document.querySelector('script[src*="greenhouse.io/embed/job_board"]');
    const fromScript = embedScript
      ? new URL(embedScript.src).searchParams.get("for")
      : null;
    if (fromScript) return { ats: "greenhouse", board: fromScript, jobId: ghJid, embedded: true };

    const labels = host.split(".").filter((l) => l && l !== "www");
    const guess = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    return { ats: "greenhouse", board: guess, boardGuessed: true, jobId: ghJid, embedded: true };
  }

  if (host.endsWith("ashbyhq.com")) {
    const match = pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (match) return { ats: "ashby", org: match[1], postingId: match[2] };
    return null;
  }

  return null;
  }

  ns.extractControls = extractControls;
  ns.detectPosting = detectPosting;
})(FirstPlay);
