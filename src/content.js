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

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const controls = ns.extractControls();
      stableFor = controls.length === previous && controls.length > 0 ? stableFor + 1 : 0;
      if (stableFor >= 2) return controls;
      previous = controls.length;
      await new Promise((r) => setTimeout(r, 500));
    }

    return ns.extractControls();
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

    const controls = await settledControls();

    if (!controls.length) {
      console.log(
        posting.embedded
          ? `${TAG} no form on this page yet — click the employer's Apply button, then run again`
          : `${TAG} no controls found after waiting — is this an application page?`
      );
      return;
    }

    console.log(`${TAG} ${posting.ats}: ${controls.length} controls read`);

    // The POST goes from the service worker, not here. A fetch from a content
    // script carries the page's origin and is subject to CORS; the worker has
    // host permission and is not.
    const response = await chrome.runtime.sendMessage({
      kind: "buildPlan",
      posting,
      controls,
      page: {
        company: document.title.split(/[—–|@]/).pop().trim() || null,
        title: document.title,
        url: window.location.href,
      },
    });

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
    const outcome = await ns.applyPlan(response.plan, { resume: stored["firstplay.resume"] || null });
    window.__firstplayOutcome = outcome;

    console.log(
      `${TAG} applied: ${outcome.filled} filled, ${outcome.attach} to attach by hand, ` +
        `${outcome.review} outlined for you, ${outcome.failed} known but could not be entered, ` +
        `${outcome.missing} in the plan but not on this page`
    );

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

    return {
      filled: outcome.filled, attach: outcome.attach, review: outcome.review,
      failed: outcome.failed, missing: outcome.missing,
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
