/**
 * Page side of the extension.
 *
 * Detects the posting, reads the controls, asks the backend for a plan, then
 * writes the plan into the page and outlines every field by what happened to
 * it. Nothing here submits, and nothing here decides — every value came from
 * the backend, which got it from the applicant's own profile.
 *
 * Classic script, not a module — see the note in extract.js.
 */
(function (ns) {
  "use strict";

  const TAG = "[FirstPlay]";

  function summarise(plan) {
    const buckets = { fill: [], sibling: [], skip: [], review: [] };

    for (const entry of plan.entries) {
      if (entry.skipped) buckets.skip.push(entry);
      else if (entry.satisfied_by) buckets.sibling.push(entry);
      else if ((entry.value !== null || entry.values.length) && !entry.needs_review)
        buckets.fill.push(entry);
      else buckets.review.push(entry);
    }

    return buckets;
  }

  function report(plan, meta) {
    const buckets = summarise(plan);

    console.log(
      `${TAG} ${plan.company || "?"} — ${plan.title || "?"}\n` +
        `  ${buckets.fill.length} to fill, ${buckets.review.length} need you, ` +
        `${buckets.skip.length} skipped, ${buckets.sibling.length} answered by a sibling\n` +
        `  ${meta.jev_calls} model call(s), $${(meta.cost_usd || 0).toFixed(6)}`
    );

    console.table(
      plan.entries.map((e) => ({
        state: e.skipped
          ? "SKIP"
          : e.satisfied_by
          ? "SIBLING"
          : (e.value !== null || e.values.length) && !e.needs_review
          ? "FILL"
          : "REVIEW",
        question: (e.label || "").slice(0, 46),
        value: e.values.length ? e.values.join(" + ") : e.value,
        source: e.source,
        why: (e.reason || "").slice(0, 44),
      }))
    );

    return buckets;
  }

  /**
   * Controls once the page has stopped adding them.
   *
   * document_idle is too early for Ashby, which renders its EEOC radio section
   * after the main form: a single read at idle saw the name and email fields
   * and none of the demographics, so the plan never mentioned them and the
   * fill skipped them. Sampling until two consecutive reads agree — rather
   * than scrolling to force rendering, which froze the renderer on a live
   * Notion posting — waits exactly as long as the page needs and no longer.
   */
  async function settledControls() {
    let previous = -1;
    let stableFor = 0;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const controls = ns.extractControls();
      stableFor = controls.length === previous && controls.length > 0 ? stableFor + 1 : 0;
      if (stableFor >= 1) return controls;
      previous = controls.length;
      await new Promise((r) => setTimeout(r, 250));
    }

    return ns.extractControls();
  }

  // The POST goes from the service worker, not here. A fetch from a content
  // script carries the page's origin and is subject to CORS; the worker has
  // host permission and is not.
  function requestPlan(posting, controls) {
    return chrome.runtime.sendMessage({
      kind: "buildPlan",
      posting,
      controls,
      page: {
        company: document.title.split(/[—–|@]/).pop().trim() || null,
        title: document.title,
        url: window.location.href,
      },
    });
  }

  async function run() {
    const posting = ns.detectPosting();

    if (!posting) {
      console.log(`${TAG} not an application page I recognise`);
      return;
    }

    // An employer page that carries the form in a Greenhouse iframe has no
    // controls of its own; the copy of this script running inside that frame
    // (all_frames) does the work, so the top frame steps aside without
    // waiting the full settle period. Measured on Lyft (app.careerpuck.com):
    // the frame appears only after "Apply" is clicked.
    const frame = document.querySelector('iframe[src*="greenhouse.io/embed/job_app"]');
    if (posting.embedded && frame && window === window.top) {
      console.log(`${TAG} the form is inside a Greenhouse frame; running there instead`);
      return;
    }

    const t0 = performance.now();

    // A Greenhouse plan depends on the API payload, not on the DOM, so the
    // request goes out now and runs while the page finishes rendering.
    // Ashby has no API; its plan needs the controls first.
    const earlyPlan = posting.ats === "greenhouse" ? requestPlan(posting, []) : null;

    const controls = await settledControls();
    // Warm the education lookups with the last plan's terms while this
    // plan is still being built (fill.js `warm`). Fire and forget.
    if (posting.ats === "greenhouse" && !document.hidden) {
      chrome.runtime.sendMessage({ kind: "warmLookups" })
        .then((r) => { if (r && r.started && r.started.length) console.log(`${TAG} warming lookups: ${r.started.join(", ")}`); })
        .catch(() => {});
    }
    const tSettled = performance.now();

    if (!controls.length) {
      console.log(
        posting.embedded
          ? `${TAG} no form on this page yet — click the employer's Apply button, then run again`
          : `${TAG} no controls found after waiting — is this an application page?`
      );
      return;
    }

    console.log(`${TAG} ${posting.ats}: ${controls.length} controls read`);

    const response = await (earlyPlan || requestPlan(posting, controls));
    const tPlanned = performance.now();

    if (!response || !response.ok) {
      console.warn(`${TAG} ${(response && response.error) || "no response from background"}`);
      return;
    }

    window.__firstplayPlan = response.plan;
    const buckets = report(response.plan, response);

    if (!response.profileAnswers) {
      console.warn(
        `${TAG} your profile is empty, so nothing could be filled.\n` +
          `  Click the extension icon and paste ~/.config/firstplay/profile.json,\n` +
          `  then reload this page.`
      );
      return;
    }

    if (!buckets.fill.length) {
      console.warn(
        `${TAG} ${response.profileAnswers} answers stored but none matched this ` +
          `form. That is unexpected — worth reporting.`
      );
      return;
    }

    // The resume lives in extension storage, put there once through the
    // popup; content scripts may read chrome.storage directly.
    const stored = await chrome.storage.local.get("firstplay.resume");
    const resume = stored["firstplay.resume"] || null;

    // Wait for the tab to be looked at *here*, before asking the service
    // worker to run the fill: a worker call that waits out a hidden tab dies
    // with the worker (MV3 stops it after a few idle minutes), the message
    // channel closes, and the fill fell back to this isolated world — where
    // dropdowns cannot be driven. General Matter, hidden 12 minutes: 15
    // "known but could not be entered". The page-world fill still waits for
    // hydration, which is seconds, not minutes.
    let hiddenMs = 0;
    if (document.hidden) {
      console.log(`${TAG} this tab is in the background — the fill starts when you switch to it`);
      const tHidden = performance.now();
      await new Promise((resolve) => {
        const onShow = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", onShow); resolve(); } };
        document.addEventListener("visibilitychange", onShow);
      });
      hiddenMs = performance.now() - tHidden;
    }

    // The fill runs in the page's world (see background.js): React's fibers,
    // which the select driver needs, are invisible from this isolated world.
    // A closed message channel is the worker having been stopped mid-call,
    // not a page problem: ask again once before giving up on the page world.
    const runInPage = () => chrome.runtime.sendMessage({ kind: "applyPlan", plan: response.plan, resume })
      .catch((e) => ({ ok: false, why: e && e.message }));
    let inPage = await runInPage();
    if (!(inPage && inPage.ok && inPage.outcome) && /message channel closed|context invalidated/i.test((inPage && inPage.why) || "")) {
      console.log(`${TAG} the extension's worker was stopped mid-fill; asking it again`);
      inPage = await runInPage();
    }
    let outcome;
    if (inPage && inPage.ok && inPage.outcome) {
      outcome = inPage.outcome;
    } else {
      console.warn(`${TAG} could not run the fill in the page's world (${(inPage && inPage.why) || "no result"}); ` +
        `falling back — dropdowns may not take values`);
      outcome = await ns.applyPlan(response.plan, { resume });
    }
    window.__firstplayOutcome = outcome;

    const tApplied = performance.now();
    const secs = (ms) => (ms / 1000).toFixed(1) + "s";

    console.log(
      `${TAG} applied: ${outcome.filled} filled, ${outcome.attach} to attach by hand, ` +
        `${outcome.review} outlined for you, ${outcome.failed} known but could not be entered, ` +
        `${outcome.missing} in the plan but not on this page`
    );
    const backendNote = response.cached ? " (plan from cache)"
      : response.elapsed_ms ? ` (backend ${secs(response.elapsed_ms)}${response.model_skipped ? ", model skipped: slow" : ""})` : "";
    console.log(
      `${TAG} timing: page settled ${secs(tSettled - t0)} · plan ready ${secs(tPlanned - t0)}${backendNote}` +
        (hiddenMs ? ` · waited for the tab ${secs(hiddenMs)}` : "") +
        ` · filled ${secs(tApplied - tPlanned - hiddenMs)} · total ${secs(tApplied - t0 - hiddenMs)}`
    );
    if (outcome.timing && outcome.timing.total !== undefined) {
      const tiers = Object.entries(outcome.timing).map(([k, v]) => `${k} ${v}ms`).join(" · ");
      const slow = (outcome.slow || []).map((s) => `${s.label} [${s.kind}] ${s.ms}ms`).join("; ");
      console.log(`${TAG} fill tiers: ${tiers}${slow ? ` · slowest: ${slow}` : ""}`);
    }

    if (outcome.failed) {
      console.warn(
        `${TAG} ${outcome.failed} answer(s) are known but this page's widget would not take ` +
          `them — each has an orange note beside it with the value to pick.`
      );
    }

    if (outcome.details.length) console.table(outcome.details);

    console.log(
      `${TAG} green = filled, amber = needs you, dashed blue = attach a file. ` +
        `Hover any outlined field for the reason. Review, then submit yourself.`
    );
    console.log(`${TAG} plan on window.__firstplayPlan, outcome on window.__firstplayOutcome`);

    // The form's own verdict. A dry-run submit — every way of sending is
    // blocked in the page for the attempt — makes the form mark what it still
    // considers missing or invalid. That list is compared with the plan: a
    // field the plan called FILL that the form calls missing is a filler
    // defect; one the plan never knew is a coverage gap.
    const check = await chrome.runtime.sendMessage({ kind: "dryRunCheck" }).catch(() => null);
    let stillRequired = null;
    if (check && check.ok) {
      const byKey = new Map(response.plan.entries.map((e) => [e.field_key, e]));
      const state = (e) => !e ? "not in plan" : e.skipped ? "skipped" : e.satisfied_by ? "sibling"
        : e.attach ? "attach" : e.needs_review ? "review" : (e.value !== null || e.values.length) ? "FILL" : "review";
      // The renderer's ids differ from the plan's keys for a few fields.
      const RENDERED_TO_KEY = { "candidate-location": "location", "school--0": "educations[0].school_name_id",
        "degree--0": "educations[0].degree_id", "discipline--0": "educations[0].discipline_id",
        "start-month--0": "educations[0].start_date.month", "start-year--0": "educations[0].start_date.year",
        "end-month--0": "educations[0].end_date.month", "end-year--0": "educations[0].end_date.year" };
      const rows = check.invalid.map((f) => {
        const key = RENDERED_TO_KEY[f.id] || f.id;
        const entry = byKey.get(key) || byKey.get(f.name) ||
          [...byKey.values()].find((e) => (e.label || "").toLowerCase().slice(0, 30) === f.label.replace(/\*$/, "").toLowerCase().slice(0, 30));
        return { form_says: f.message || "required", field: f.label, plan_said: state(entry) };
      });
      stillRequired = rows.length;
      console.log(`${TAG} form check: the form still wants ${rows.length} field(s)`);
      // Plain lines as well as the table: a pasted console log or a log
      // reader never carries console.table's contents.
      for (const r of rows) console.log(`${TAG}   form wants: ${r.field} ⇐ plan said ${r.plan_said}${r.form_says ? ` (${r.form_says})` : ""}`);
      if (rows.length) console.table(rows);
      const defects = rows.filter((r) => r.plan_said === "FILL");
      if (defects.length) console.warn(`${TAG} ${defects.length} field(s) the plan called FILL are empty by the form's own account — filler defect, please report`);
    } else if (check) {
      console.log(`${TAG} form check skipped: ${check.why}`);
    }

    return {
      still_required: stillRequired,
      filled: outcome.filled, attach: outcome.attach, review: outcome.review,
      failed: outcome.failed, missing: outcome.missing, seconds: (tApplied - t0) / 1000,
    };
  }

  let inFlight = null;

  // One run at a time. The popup injects these files (which auto-run below)
  // and then calls run() so that a host where they had already auto-run gets
  // a fresh pass; on a fresh landing that second call finds the first still in
  // flight and does nothing, instead of filling the form twice.
  ns.run = function () {
    if (inFlight) return inFlight;
    inFlight = run()
      .catch((e) => console.warn(`${TAG} ${e && e.message}`))
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  // Auto-run once per landing, on matched hosts and on-demand injections alike.
  if (!window.__firstplayRan) {
    window.__firstplayRan = true;
    ns.run();
  }
})(FirstPlay);
