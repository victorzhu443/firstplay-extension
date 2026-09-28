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

/** A short, stable key for "this posting, this profile": the plan is a pure function of both. */
async function planCacheKey(posting, profile) {
  const text = JSON.stringify([posting.ats, posting.board || posting.org, posting.jobId || posting.postingId, profile]);
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
  const cacheKey = posting.ats === "greenhouse" ? await planCacheKey(posting, profile) : null;
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
    body = {
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

  // Reported so an empty profile is distinguishable from a broken resolver.
  // Without it, "0 to fill, 19 need you" looks identical to a bug, and the
  // actual cause — nothing saved in this browser — is invisible.
  return { ok: true, profileAnswers: answers, ...payload };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.kind !== "buildPlan") return false;

  buildPlan(message)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message }));

  // Keeps the message channel open for the async reply. Without it the content
  // script's await resolves to undefined and the failure looks like a missing
  // listener.
  return true;
});
