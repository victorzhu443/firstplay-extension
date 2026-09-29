/**
 * Service worker: the only place that talks to the network.
 *
 * Two reasons it lives here rather than in the content script:
 *
 *   - **CORS.** A fetch from a content script carries the page's origin
 *     (https://job-boards.greenhouse.io), which the backend would have to
 *     allow. The worker holds host permission and is exempt, so the backend's
 *     allowlist stays as it is.
 *   - **The profile.** It is read from chrome.storage.local here and sent to the
 *     backend per request. It is never injected into the page, so a script on
 *     the application site cannot reach it.
 */
import { BACKEND, PROFILE_KEY } from "./config.js";

/** The applicant's profile, or an empty one on first run. */
async function loadProfile() {
  const stored = await chrome.storage.local.get(PROFILE_KEY);

  return stored[PROFILE_KEY] || {};
}

/**
 * Greenhouse publishes the authoritative form schema, unauthenticated.
 *
 * Preferred over the DOM extract wherever it is available: it carries field
 * names, types, required flags and option label/value pairs directly, and the
 * value a select submits is frequently not the text on screen. The DOM is still
 * needed to locate the live controls, but not to understand them.
 */
async function fetchGreenhouseSchema(board, jobId) {
  const url =
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}` +
    `/jobs/${encodeURIComponent(jobId)}?questions=true`;

  const response = await fetch(url);

  if (!response.ok) throw new Error(`Greenhouse API returned ${response.status}`);

  const schema = await response.json();

  // A guessed board token could name a *different* company whose board
  // happens to exist; the job the API returns must be the one the page asked
  // for, or the plan would be built against a stranger's form.
  if (String(schema.id) !== String(jobId)) {
    throw new Error(`board "${board}" returned job ${schema.id}, not ${jobId}`);
  }

  // The education block is described only by a mode flag; its degree and
  // discipline vocabularies live on two more public endpoints of the same
  // board. 36 of 57 corpus postings require the block, so this is the rule,
  // not the exception. A failed fetch leaves the two as free text.
  if (schema.education === "education_required" || schema.education === "education_optional") {
    const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/education/`;
    const [degrees, disciplines] = await Promise.all(
      ["degrees", "disciplines"].map((kind) =>
        fetch(base + kind).then((r) => (r.ok ? r.json() : { items: [] }))
          .then((j) => j.items || []).catch(() => [])
      )
    );
    schema.education_options = { degrees, disciplines };
  }

  return schema;
}

/** How many answers a profile actually holds, for reporting an empty one. */
function countAnswers(profile) {
  return ["facts", "education", "legal_status", "preferences", "protected"].reduce(
    (total, section) =>
      total + Object.values(profile[section] || {}).filter((v) => v).length,
    0
  );
}

/**
 * Which engine the backend is running, from its health route. A plan is a
 * function of the engine as much as of the posting and profile: after a
 * backend change a cached pre-change plan was served for twelve minutes on
 * the board meant to test the change (DECISIONS §40). Local and fast; on
 * failure the key carries "unknown" and a cached plan is still better than none.
 */
async function engineFingerprint() {
  try {
    const res = await fetch(`${BACKEND}/api/autofill/health`, { cache: "no-store" });
    const body = await res.json();
    return body.engine || "unknown";
  } catch (_e) {
    return "unknown";
  }
}

/** A short, stable key for "this posting, this profile, this engine": the plan is a pure function of the three. */
async function planCacheKey(posting, profile) {
  const engine = await engineFingerprint();
  const text = JSON.stringify([posting.ats, posting.board || posting.org, posting.jobId || posting.postingId, profile, engine]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "firstplay.plan." + Array.from(new Uint8Array(digest)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildPlan({ posting, controls, page }) {
  const profile = await loadProfile();
  const answers = countAnswers(profile);

  // A Greenhouse plan is a pure function of the posting and the profile, so a
  // re-run of the same page (after clicking Apply, after a reload, after
  // fixing one field by hand) should not pay the backend again. Session
  // storage: gone when the browser closes, and the profile hash is in the key,
  // so an edited profile misses. Ashby plans depend on the DOM and are not cached.
  // Greenhouse and Ashby plans are both pure functions of an API payload
  // and the profile (Ashby's form comes from its ApiJobPosting operation,
  // DECISIONS §46), so both are cached; a DOM-read Ashby plan is not.
  const cacheKey = posting.ats === "greenhouse" || (posting.ats === "ashby" && !(controls && controls.length))
    ? await planCacheKey(posting, profile) : null;
  if (cacheKey) {
    const hit = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) {
      return { ok: true, profileAnswers: answers, cached: true, ...hit.payload };
    }
  }

  let body;

  if (posting.ats === "greenhouse") {
    let form;
    try {
      form = await fetchGreenhouseSchema(posting.board, posting.jobId);
    } catch (e) {
      if (posting.boardGuessed) {
        throw new Error(
          `this page carries Greenhouse job ${posting.jobId} but its board could not be ` +
          `inferred from the domain (tried "${posting.board}"; ${e.message}). ` +
          `Open the posting on job-boards.greenhouse.io instead.`
        );
      }
      throw e;
    }
    body = { ats: "greenhouse", form, profile };
  } else {
    // Ashby: the form definition from the page's own GraphQL operation.
    // The DOM extract is the fallback when the operation fails or when an
    // older content script sent controls only.
    let jobPosting = null;
    try {
      jobPosting = await fetchAshbyPosting(posting.org, posting.postingId);
    } catch (e) {
      if (!(controls && controls.length)) throw new Error(`Ashby's form definition could not be fetched (${e.message})`);
    }
    body = jobPosting
      ? { ats: "ashby", form: { ...jobPosting, _org: posting.org }, profile }
      : {
          ats: "ashby",
          form: {
            posting_id: posting.postingId,
            company: posting.org,
            title: page.title,
            apply_url: page.url,
            controls,
          },
          profile,
        };
  }

  const response = await fetch(`${BACKEND}/api/autofill/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`backend returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();

  // Only a plan the model finished is worth remembering; one where it timed
  // out should be retried next time.
  if (cacheKey && !payload.model_skipped) {
    chrome.storage.session.set({ [cacheKey]: { at: Date.now(), payload } }).catch(() => {});
  }
  rememberLookupTerms(payload);

  // Reported so an empty profile is distinguishable from a broken resolver.
  // Without it, "0 to fill, 19 need you" looks identical to a bug, and the
  // actual cause — nothing saved in this browser — is invisible.
  return { ok: true, profileAnswers: answers, ...payload };
}

/**
 * Runs IN THE PAGE (main world): press Submit with every way of leaving the
 * page blocked, and read the form's own validation. Greenhouse validates
 * client-side before posting, so the messages are the form's verdict on each
 * field. Nothing can be sent: fetch, XHR, sendBeacon, form.submit and the
 * submit event are all stopped for the duration, then restored.
 */
function dryRunSubmitInPage() {
  return new Promise((resolve) => {
    const blocked = [];
    const F = window.fetch, XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    const SB = navigator.sendBeacon, FS = HTMLFormElement.prototype.submit;
    window.fetch = function (u, o) {
      const m = ((o && o.method) || "GET").toUpperCase();
      if (m !== "GET") { blocked.push(`fetch ${m}`); return Promise.reject(new Error("FirstPlay dry run")); }
      return F.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function (m) { this.__fpm = m; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      if ((this.__fpm || "GET").toUpperCase() !== "GET") { blocked.push("xhr " + this.__fpm); this.abort(); return; }
      return XS.apply(this, arguments);
    };
    navigator.sendBeacon = function () { blocked.push("beacon"); return false; };
    HTMLFormElement.prototype.submit = function () { blocked.push("form.submit"); };
    const stop = (e) => { blocked.push("submit event"); e.preventDefault(); e.stopImmediatePropagation(); };
    document.addEventListener("submit", stop, true);
    const unload = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", unload);

    const restore = () => {
      window.fetch = F; XMLHttpRequest.prototype.open = XO; XMLHttpRequest.prototype.send = XS;
      navigator.sendBeacon = SB; HTMLFormElement.prototype.submit = FS;
      document.removeEventListener("submit", stop, true); window.removeEventListener("beforeunload", unload);
    };

    const form = document.querySelector("form");
    const buttons = form ? Array.from(form.querySelectorAll('button, input[type="submit"]')) : [];
    const button = buttons.find((b) => /submit application|^submit$/i.test((b.innerText || b.value || "").trim()))
      || (form && form.querySelector('button[type="submit"], input[type="submit"]'))
      || buttons.find((b) => /submit/i.test(b.innerText || ""));
    if (!button) { restore(); resolve({ ok: false, why: "no submit button found" }); return; }

    const collect = () => {
      const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"]'));
      const labelOf = (el) => {
        const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const near = el.closest("div, fieldset");
        const lab = byFor || (near && near.querySelector("label, legend"));
        return lab ? lab.innerText.trim().slice(0, 60) : (el.id || el.name || el.tagName);
      };
      const messageOf = (el) => {
        const ids = (el.getAttribute("aria-describedby") || el.getAttribute("aria-errormessage") || "").split(/\s+/).filter(Boolean);
        for (const id of ids) { const m = document.getElementById(id); if (m && m.innerText.trim()) return m.innerText.trim().slice(0, 80); }
        const near = el.closest("div, fieldset");
        const m = near && near.querySelector('[class*="error"], [role="alert"]');
        return m ? m.innerText.trim().slice(0, 80) : "";
      };
      // Ashby marks a failed field with an error message inside its
      // container rather than aria-invalid on the control.
      for (const container of document.querySelectorAll("[data-field-path]")) {
        const message = container.querySelector('[class*="error"], [role="alert"]');
        if (!message || !message.innerText.trim()) continue;
        const control = container.querySelector('input:not([type="hidden"]), textarea, select, [role="combobox"]');
        if (control && !invalid.includes(control)) invalid.push(control);
      }
      const fields = [];
      const seen = new Set();
      for (const el of invalid) {
        const key = (el.id || el.name || "").replace(/^react-select-|-input$/g, "");
        const label = labelOf(el);
        const sig = label + "|" + key;
        if (seen.has(sig)) continue;
        seen.add(sig);
        fields.push({ id: el.id || "", name: el.name || "", label, message: messageOf(el) });
      }
      return fields;
    };

    let done = false;
    const finish = () => {
      if (done) return; done = true;
      const fields = collect();
      restore();
      resolve({ ok: true, invalid: fields, blocked, submitButton: button.innerText.trim().slice(0, 40) });
    };
    const mo = new MutationObserver(() => { if (document.querySelector('[aria-invalid="true"]')) { mo.disconnect(); setTimeout(finish, 150); } });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-invalid", "class"] });
    setTimeout(() => { mo.disconnect(); finish(); }, 4000);
    button.click();
  });
}

/**
 * Apply the plan IN THE PAGE'S WORLD. Content scripts live in an isolated
 * world that shares the DOM but not the properties page scripts attach to
 * nodes — and React's fiber (`__reactFiber$…`), which the react-select
 * driver needs, is such a property. From the isolated world every standard
 * Greenhouse select reported "not a react-select instance" (Coinbase,
 * Chicago Trading, NISC, Clockwork, 2026-09-28) while the same page showed
 * the instances to a page-world probe. So fill.js is injected into the main
 * world and applyPlan runs there; the outcome comes back as the result.
 */
/**
 * Ashby's application form, from the operation the page itself sends
 * (`ApiJobPosting`; query text recovered from Ashby's bundle, checked in as
 * ashby_posting.graphql). Public, no auth. Returns the `jobPosting` object,
 * whose `applicationForm.sections[].fieldEntries[]` the backend normalises.
 */
let ashbyQueryText = null;
async function fetchAshbyPosting(org, postingId) {
  if (!ashbyQueryText) ashbyQueryText = await (await fetch(chrome.runtime.getURL("src/ashby_posting.graphql"))).text();
  const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
    method: "POST",
    headers: { "Content-Type": "application/json", "apollographql-client-name": "frontend_non_user" },
    body: JSON.stringify({
      operationName: "ApiJobPosting",
      variables: { organizationHostedJobsPageName: org, jobPostingId: postingId },
      query: ashbyQueryText,
    }),
  });
  if (!res.ok) throw new Error(`ApiJobPosting ${res.status}`);
  const json = await res.json();
  const jobPosting = json && json.data && json.data.jobPosting;
  if (!jobPosting || !jobPosting.applicationForm) throw new Error("ApiJobPosting returned no applicationForm");
  return jobPosting;
}

/** The education terms this plan will look up; the next board warms them before its plan arrives. */
const TERM_CONTROLS = [
  [/^educations\[0\]\.school_name_id$/, "school--0"],
  [/^educations\[0\]\.degree_id$/, "degree--0"],
  [/^educations\[0\]\.discipline_id$/, "discipline--0"],
];

function rememberLookupTerms(payload) {
  const entries = (payload && payload.plan && payload.plan.entries) || [];
  const terms = {};
  for (const entry of entries) {
    if (!entry.value || entry.needs_review || entry.skipped) continue;
    for (const [pattern, id] of TERM_CONTROLS) if (pattern.test(entry.field_key)) terms[id] = entry.value;
  }
  if (Object.keys(terms).length) chrome.storage.session.set({ "firstplay.terms": terms }).catch(() => {});
}

async function warmLookupsInPage(sender) {
  const stored = await chrome.storage.session.get("firstplay.terms");
  const terms = stored["firstplay.terms"];
  if (!terms) return { ok: true, started: [] };
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  await chrome.scripting.executeScript({ target, world: "MAIN", files: ["src/fill.js"] });
  const results = await chrome.scripting.executeScript({
    target, world: "MAIN",
    func: (t) => window.FirstPlay.warm(t),
    args: [terms],
  });
  return { ok: true, started: (results && results[0] && results[0].result) || [] };
}

async function applyPlanInPage(sender, plan, resume) {
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  await chrome.scripting.executeScript({ target, world: "MAIN", files: ["src/fill.js"] });
  const results = await chrome.scripting.executeScript({
    target, world: "MAIN",
    func: (p, r) => window.FirstPlay.applyPlan(p, { resume: r }),
    args: [plan, resume || null],
  });
  return (results && results[0] && results[0].result) || null;
}

async function dryRunCheck(sender) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
    world: "MAIN",
    func: dryRunSubmitInPage,
  });
  return (results && results[0] && results[0].result) || { ok: false, why: "no result" };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.kind === "warmLookups") {
    warmLookupsInPage(_sender)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, why: e.message }));
    return true;
  }
  if (message.kind === "applyPlan") {
    applyPlanInPage(_sender, message.plan, message.resume)
      .then((outcome) => sendResponse({ ok: !!outcome, outcome }))
      .catch((e) => sendResponse({ ok: false, why: e.message }));
    return true;
  }
  if (message.kind === "dryRunCheck") {
    dryRunCheck(_sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, why: e.message }));
    return true;
  }
  if (message.kind !== "buildPlan") return false;

  buildPlan(message)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));

  // Keeps the message channel open for the async reply. Without it the content
  // script's await resolves to undefined and the failure looks like a missing
  // listener.
  return true;
});
