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
  // A tab hidden for more than five minutes gets Chrome's intensive timer
  // throttling: setTimeout fires about once a minute, and a 250 ms settle
  // loop takes ten. A MessageChannel message is not throttled; fill.js
  // already sleeps this way when hidden (0.4.16), and so does this loop now.
  function pause(ms) {
    if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
    return new Promise((resolve) => {
      const started = performance.now();
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (performance.now() - started >= ms) resolve(); else channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
    });
  }

  async function settledControls() {
    let previous = -1;
    let stableFor = 0;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const controls = ns.extractControls();
      stableFor = controls.length === previous && controls.length > 0 ? stableFor + 1 : 0;
      if (stableFor >= 1) return controls;
      previous = controls.length;
      await pause(250);
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
    // Only a document on an ATS origin is ever read for a plan or written
    // to. An employer's own careers page that embeds a Greenhouse form has
    // the form in a boards.greenhouse.io iframe; the copy of this script
    // running there (all_frames in the manifest, allFrames from the popup)
    // detects `/embed/job_app` and fills. This frame — the third-party
    // document — hands off and is never filled, so nothing of the
    // applicant's goes to it (audit F3). Measured on Lyft
    // (app.careerpuck.com): the frame appears only after "Apply" is clicked.
    const posting = ns.atsOfHost(window.location.host) ? ns.detectPosting() : null;

    if (!posting) {
      const hint = ns.embeddedHint ? ns.embeddedHint() : null;
      if (hint && hint.frame) {
        console.log(`${TAG} the form is inside a Greenhouse frame (${hint.frame.board || "?"}/${hint.frame.jobId || "?"}); ` +
          `the copy of this script in that frame fills it; nothing is filled on ${hint.host}`);
        return { handedOff: true, host: hint.host, frame: hint.frame };
      }
      if (hint && hint.jobId) {
        console.log(`${TAG} this page names Greenhouse job ${hint.jobId}${hint.board ? ` on board ${hint.board}` : ""} but holds no ` +
          `Greenhouse form frame yet — click the employer's Apply button, then run again`);
        return { handedOff: false, host: hint.host, jobId: hint.jobId, board: hint.board };
      }
      console.log(`${TAG} not an application page I recognise`);
      return;
    }

    const t0 = performance.now();

    // A Greenhouse or Ashby plan depends on an API payload, not on the DOM,
    // so the request goes out now and runs while the page finishes
    // rendering (Ashby: the page's own ApiJobPosting operation, §46).
    const earlyPlan = requestPlan(posting, []);

    const controls = await settledControls();
    // Warm the Greenhouse education lookups with the last plan's terms while
    // this plan is still being built (fill.js `warm`): loader reads only,
    // nothing typed. Never on Ashby, which autosaves what is typed (F17).
    if (posting.ats === "greenhouse") {
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

    let response = await earlyPlan;
    // Ashby's operation failed: fall back to the plan built from the DOM read.
    if (!(response && response.ok) && posting.ats === "ashby" && controls.length) {
      response = await requestPlan(posting, controls);
    }
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
    const stored = await chrome.storage.local.get(["firstplay.resume", "firstplay.transcript"]);
    const resume = stored["firstplay.resume"] || null;
    const transcript = stored["firstplay.transcript"] || null;

    // Wait for the tab to be looked at *here*, before asking the service
    // worker to run the fill: a worker call that waits out a hidden tab dies
    // with the worker (MV3 stops it after a few idle minutes), the message
    // channel closes, and the fill fell back to this isolated world — where
    // dropdowns cannot be driven. General Matter, hidden 12 minutes: 15
    // "known but could not be entered". The page-world fill still waits for
    // hydration, which is seconds, not minutes.
    // Greenhouse does not hydrate a hidden tab and its re-render discards
    // early writes (§37), so a hidden Greenhouse tab waits. Ashby renders
    // its whole form client-side whether or not the tab is looked at —
    // every field was present on hidden probes — so an Ashby tab fills in
    // the background and is done by the time it is opened.
    let hiddenMs = 0;
    if (document.hidden && posting.ats !== "ashby") {
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
    // What crosses into the page's world is readable by any script there,
    // so only what the fill needs goes: the values of entries it will write
    // (review, skipped and sibling entries travel without theirs), and the
    // documents only when the page has a file input to put them in (audit L7).
    const pagePlan = pagePlanFor(response.plan);
    const hasFileSlot = document.querySelector('input[type="file"]') !== null;
    const pageResume = hasFileSlot ? resume : null;
    const pageTranscript = hasFileSlot ? transcript : null;
    const runInPage = () => chrome.runtime.sendMessage({ kind: "applyPlan", plan: pagePlan, resume: pageResume, transcript: pageTranscript })
      .catch((e) => ({ ok: false, why: e && e.message }));
    let inPage = await runInPage();
    if (!(inPage && inPage.ok && inPage.outcome) && /message channel closed|context invalidated/i.test((inPage && inPage.why) || "")) {
      console.log(`${TAG} the extension's worker was stopped mid-fill; asking it again`);
      inPage = await runInPage();
    }
    let outcome;
    let world = "main";
    if (inPage && inPage.ok && inPage.outcome) {
      outcome = inPage.outcome;
    } else {
      world = "isolated";
      console.warn(`${TAG} could not run the fill in the page's world (${(inPage && inPage.why) || "no result"}); ` +
        `falling back — dropdowns may not take values`);
      outcome = await ns.applyPlan(pagePlan, { resume: pageResume, transcript: pageTranscript });
    }
    window.__firstplayOutcome = outcome;

    // Every field the plan knew but the page would not take is kept, with the
    // page and the reason, so "FirstPlay knows this one — please pick it" can
    // be diagnosed from real use instead of from a report. Victor, 2026-10-12:
    // Questions the profile could not answer: the plan marks each such entry
    // with the profile key, section, prompt and example it needs. They go to
    // the popup, which asks the applicant and saves the answer into the
    // profile (Victor, 2026-10-12: "you also need to be able to edit this
    // stuff and ask the user for this information"). No values leave here.
    let asksSent = 0;
    try {
      const where = `${location.host}${location.pathname}`.slice(0, 120);
      const asks = (response.plan.entries || [])
        .filter((e) => e && e.needs_fact && e.needs_fact.key)
        .map((e) => ({
          section: e.needs_fact.section, key: e.needs_fact.key,
          prompt: (e.needs_fact.prompt || "").slice(0, 160), example: e.needs_fact.example || "",
          note: (e.needs_fact.note || "").slice(0, 200), label: (e.label || "").slice(0, 120),
          required: !!e.required, where,
        }));
      asksSent = asks.length;
      if (asks.length) chrome.runtime.sendMessage({ kind: "asks", asks }).catch(() => {});
    } catch (e) { /* asking is a convenience; never break the run */ }

    // "I keep getting that it knows what should be chosen but can't choose it."
    // No values: label, widget reason, host and path only.
    try {
      const misses = (outcome.details || []).filter((d) => d.state === "failed" || d.state === "mismatch");
      if (misses.length) {
        const where = `${location.host}${location.pathname}`.slice(0, 120);
        const rows = misses.map((d) => missRow(d, posting, where));
        chrome.storage.local.get("firstplay.misses").then((stored) => {
          const kept = (stored["firstplay.misses"] || []).concat(rows).slice(-100);
          return chrome.storage.local.set({ "firstplay.misses": kept });
        }).catch(() => {});
      }
    } catch (e) { /* never let the log break the run */ }

    // Ashby restores the applicant's saved draft asynchronously, and a draft
    // from an earlier visit can land *after* the fill and overwrite it. Seen
    // on Forus (2026-10-09): the plan said Summer, the page showed the Winter
    // chosen on an earlier visit. Two seconds after the fill, every filled
    // entry is read back; anything that no longer holds the plan's value is
    // applied once more and counted as drift.
    if (posting.ats === "ashby" && ns._learn && ns._learn.readValue) {
      await pause(2000);
      const same = (a, b) => {
        const norm = (v) => (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined)
          .map((x) => String(x).trim().toLowerCase().replace(/\s+/g, " ")).sort().join("|");
        return norm(a) === norm(b);
      };
      const drifted = [];
      for (const entry of response.plan.entries) {
        const planned = entry.values && entry.values.length ? entry.values : entry.value;
        if (planned === null || planned === undefined || planned === "" || entry.needs_review || entry.skipped || entry.satisfied_by || entry.attach) continue;
        const el = ns.locate(entry);
        if (!el || (el.type || "").toLowerCase() === "file") continue;
        let shown;
        try { shown = ns._learn.readValue(el).value; } catch (e) { continue; }
        if (shown === undefined || shown === null || shown === "" || (Array.isArray(shown) && !shown.length)) continue;  // not readable here; the check below still runs
        // A date picker shows the date in its own format ("05/01/2028" for
        // a stored "May 2028"); the same date is not drift.
        if (ns._fill && ns._fill.isDatePicker && ns._fill.isDatePicker(el) && ns._learn.sameDate && ns._learn.sameDate(String(planned), String(shown))) continue;
        if (!same(shown, planned)) drifted.push(entry);
      }
      outcome.drift = drifted.length;
      if (drifted.length) {
        console.warn(`${TAG} ${drifted.length} filled field(s) changed after the fill (a saved draft?): ` +
          drifted.map((e) => e.label).join("; ") + " — applying once more");
        try { await ns.applyPlan({ entries: drifted }, { resume, transcript }); } catch (e) { console.warn(`${TAG} re-apply failed: ${e && e.message}`); }
      }
    }

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

    // What the form still wants, compared with the plan: a field the plan
    // called FILL that is still empty is a filler defect; one the plan never
    // knew is a coverage gap.
    // The form commits the last write a frame later; asking it before that
    // flags filled fields as required (0.4.24).
    if (document.hidden) await pause(150);
    else await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));
    // Never by pressing Submit. Until 0.4.52 Greenhouse was asked by a
    // "dry-run" click on the real Submit button inside a four-second
    // monkeypatch of fetch/XHR/beacon/form.submit; nothing ever showed the
    // patch blocking anything, and a page holding its own reference to
    // fetch would have posted the application (audit F4). Both vendors are
    // now checked locally: the plan's required flags plus the DOM's own
    // signals, against the page's current values. Ashby validates only on
    // its server and was never clicked (§47). The click survives only as a
    // developer setting, firstplay.dryRun.click, and even then a form that
    // reads complete is not clicked — that click would be the submission.
    let check;
    let checkMode;
    let dryRunBypassed = false;
    let domRows = null;   // the local verdict, kept beside the click's when both ran
    if (posting.ats === "ashby") {
      check = localRequiredCheck(response.plan);
      checkMode = "ashby-local";
    } else {
      check = domRequiredCheck(response.plan);
      checkMode = "dom";
      if (await devFlag("firstplay.dryRun.click")) {
        if (!check.invalid.length) {
          checkMode = "click-skipped";
          console.warn(`${TAG} dryRun.click is on, but the form reads complete — a click would be a real submission attempt; not clicked`);
        } else {
          const clicked = await chrome.runtime.sendMessage({ kind: "dryRunCheck" }).catch(() => null);
          if (clicked && clicked.ok) {
            domRows = check.invalid;
            check = clicked;
            checkMode = "click";
            // The form flagged nothing and the patch blocked nothing: either
            // nothing happened or the send went around the patch. Not
            // trusted either way; recorded as a bypass for the live check.
            dryRunBypassed = !clicked.invalid.length && !(clicked.blocked || []).length;
            if (dryRunBypassed) console.warn(`${TAG} dry-run click: the form marked nothing invalid and nothing was blocked — the result is not trusted (dry_run_bypassed)`);
          } else {
            console.log(`${TAG} dry-run click skipped: ${(clicked && clicked.why) || "no result"}`);
          }
        }
      }
    }
    let stillRequired = null;
    let wantRows = [];
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
        // An option input's id names its question before `-labeled-…`.
        const bare = String(f.id || "").replace(/-labeled-(?:checkbox|radio)(?:-\d+)?$/, "");
        const key = RENDERED_TO_KEY[f.id] || (byKey.has(f.id) ? f.id : bare);
        const entry = byKey.get(key) || byKey.get(f.name) ||
          [...byKey.values()].find((e) => (e.label || "").toLowerCase().slice(0, 30) === f.label.replace(/\*$/, "").toLowerCase().slice(0, 30));
        return { form_says: f.message || "required", field: f.label, plan_said: state(entry) };
      });
      stillRequired = rows.length;
      wantRows = rows;
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

    // The run's record, on the document for anything that reads the page
    // (the survey harness, a bug report) and in storage for the popup's
    // "Copy diagnostics": counts, tiers, what the form still wants, every
    // field's source, confidence and result, what the check did, and which
    // engine, backend host and world served it with the model's flags
    // (audit F21: a failed model path looked like no call at all). No
    // values, no profile.
    try {
      const blocked = checkMode === "click" && Array.isArray(check.blocked) ? check.blocked.map((b) => String(b).slice(0, 24)) : null;
      const record = {
        version: chrome.runtime.getManifest().version,
        at: new Date().toISOString(),
        ats: posting.ats, where: `${location.host}${location.pathname}`.slice(0, 120),
        engine: response.engine || null,
        backend: response.backend || null,
        world,
        cache_hit: !!response.cached,
        model_skipped: !!response.model_skipped, model_degraded: !!response.model_degraded,
        model_available: response.model_available === undefined ? null : !!response.model_available,
        jev_calls: response.jev_calls || 0,
        filled: outcome.filled, attach: outcome.attach, review: outcome.review,
        failed: outcome.failed, missing: outcome.missing,
        fill_ms: outcome.timing && outcome.timing.total, tiers: outcome.timing || null,
        slow: outcome.slow || [],
        plan_ms: Math.round(tPlanned - t0), backend_ms: response.elapsed_ms || 0, cached: !!response.cached,
        drift: outcome.drift || 0,
        asks: asksSent,
        still_required: stillRequired,
        wants: wantRows.map((r) => ({ field: r.field.slice(0, 60), plan_said: r.plan_said, form_says: (r.form_says || "").slice(0, 60) })),
        failures: (outcome.details || []).filter((d) => d.state === "failed").map((d) => ({ label: (d.label || "").slice(0, 60), why: scrubReason(d.why) })),
        fields: (outcome.fields || []).slice(0, 200),
        check_mode: checkMode,
        submit_clicked: checkMode === "click",
        blocked: blocked ? { count: blocked.length, methods: Array.from(new Set(blocked)) } : null,
        dry_run_bypassed: dryRunBypassed,
        dom_wants: domRows ? domRows.map((f) => ({ field: String(f.label || "").slice(0, 60), message: String(f.message || "").slice(0, 60) })) : null,
        check_skipped: check && !check.ok ? check.why : null,
      };
      // Only when the backend says so (the fields are being added there);
      // an older backend leaves them absent rather than false.
      if (response.model_failed !== undefined) record.model_failed = !!response.model_failed;
      if (response.model_error !== undefined && response.model_error !== null) record.model_error = String(response.model_error).slice(0, 120);
      document.documentElement.setAttribute("data-firstplay-outcome", JSON.stringify(record));
      chrome.storage.local.set({ "firstplay.lastRecord": record }).catch(() => {});
    } catch (_e) { /* the record is a convenience */ }

    // From here on the applicant edits; what they type, pick and correct is
    // the ground truth this plan lacked (learn.js). Watching, never writing.
    if (ns.watchForLearning) {
      try { ns.watchForLearning(posting, response.plan); } catch (e) { console.warn(`${TAG} learning watch not started: ${e && e.message}`); }
    }

    return {
      still_required: stillRequired,
      filled: outcome.filled, attach: outcome.attach, review: outcome.review,
      failed: outcome.failed, missing: outcome.missing, seconds: (tApplied - t0) / 1000,
    };
  }

  /**
   * The plan as the page's world may see it. Entries the fill will not write
   * — review, skipped, answered by a sibling — keep their key, label, flags
   * and reason but not their value, so an answer the applicant never approved
   * for this form is not handed to the page's scripts. The isolated world
   * keeps the full plan for the drift check and the learning watch.
   */
  /** A reason with no quoted values in it — the same rule as fill.js's scrubWhy (that runs in the page's world). */
  function scrubReason(why) {
    if (!why) return why;
    return String(why)
      .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
      .replace(/(^|[\s(;:,])'(?:[^'\\]|\\.)*'(?=$|[\s).;:,])/g, "$1'…'")
      .slice(0, 80);
  }

  /**
   * One row of the misses log (`firstplay.misses`, shown and copied from the
   * popup). The widget's reason quotes the value it refused ("no choice is
   * exactly "…""), so it is scrubbed here the way the run record's is;
   * docs/PRIVACY.md says the log holds no values (audit F6).
   */
  function missRow(d, posting, where) {
    return {
      at: new Date().toISOString(), ats: posting.ats, where, title: (document.title || "").slice(0, 80),
      label: (d.label || "").slice(0, 80), state: d.state, why: scrubReason(d.why) || "",
      version: chrome.runtime.getManifest().version,
    };
  }

  function pagePlanFor(plan) {
    const entries = (plan.entries || []).map((e) => {
      const writes = !e.needs_review && !e.skipped && !e.satisfied_by && (e.value !== null || (e.values && e.values.length));
      // The reason can quote the value it refused ("'Ithaca, NY' is not an
      // answer"); scrubbed along with the value (review of 2026-10-12).
      return writes ? e : { ...e, value: null, values: [], needs_fact: null, reason: scrubReason(e.reason) };
    });
    return { ...plan, entries };
  }

  /**
   * What a Greenhouse form still wants, without pressing Submit. Required
   * is any of: the plan's `required` (the board API's flag), the control's
   * `required`, `aria-required="true"`, Greenhouse's label convention
   * (the label text ends in "*"), or an `aria-invalid="true"` the form has
   * already set (then the form's own message is reported). Empty is read
   * the way the learning capture reads values: react-selects by their
   * rendered value, radios and checkboxes by `checked`, files by `files`.
   * First the plan's entries (by key), then every other control on the
   * page that carries a required signal — a field the plan never knew is a
   * coverage gap, as before. Same shape as the dry run, so the diff reads
   * it unchanged.
   *
   * What this cannot see that the form's own validation can: format rules
   * (an email or URL shape the form rejects), conditional requirements the
   * form computes in script without marking the DOM, and the react-select
   * wrapper-state defect of §44 (a widget that displays a value the form's
   * state did not take). The live comparison against the click is the
   * developer setting above.
   */
  function domRequiredCheck(plan) {
    const invalid = [];
    const seen = new Set();
    const text = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
    const labelElementOf = (el) => {
      if (el.tagName === "FIELDSET") return el.querySelector("legend");
      const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) return byFor;
      const wrapping = el.closest("label");
      if (wrapping) return wrapping;
      const group = el.closest('[role="group"], fieldset');
      return group ? group.querySelector("label, legend") : null;
    };
    const labelOf = (el, entry) => {
      // An option input's own label is the option ("Summer Internship"); the
      // question is the plan's label.
      if (entry && entry.label && isChoice(el)) return String(entry.label).replace(/\s*\*\s*$/, "").slice(0, 60);
      const lab = labelElementOf(el);
      const raw = lab ? text(lab) : (entry && entry.label) || el.getAttribute("aria-label") || el.getAttribute("placeholder")
        || el.id || el.name || el.tagName;
      return raw.replace(/\s*\*\s*$/, "").slice(0, 60);
    };
    const messageOf = (el) => {
      const ids = (el.getAttribute("aria-describedby") || el.getAttribute("aria-errormessage") || "").split(/\s+/).filter(Boolean);
      for (const id of ids) { const m = document.getElementById(id); if (m && text(m)) return text(m).slice(0, 80); }
      const near = el.closest("div, fieldset");
      const m = near && near.querySelector('[class*="error"], [role="alert"]');
      return m ? text(m).slice(0, 80) : "";
    };
    const signalsOf = (el, entry) => {
      const signals = [];
      if (entry && entry.required) signals.push("plan");
      const isSet = el.tagName === "FIELDSET"
        ? !!el.querySelector('[required], [aria-required="true"]')
        : (el.required === true || el.getAttribute("required") !== null);
      if (isSet) signals.push("required");
      if (el.getAttribute("aria-required") === "true") signals.push("aria-required");
      const lab = labelElementOf(el);
      if (lab && /\*\s*$/.test(text(lab))) signals.push("* label");
      if (el.getAttribute("aria-invalid") === "true") signals.push("aria-invalid");
      return signals;
    };
    // A checkbox or radio question is one control however many inputs it
    // has: a group holds a value when any of its boxes is checked, and it
    // is reported once, under the plan's key. Greenhouse renders the
    // question `question_N` as `question_N-labeled-checkbox-0`, `-1`, …
    // (R50: consents on Signifyd, Attentive and InternshipList were "not in
    // plan" by their input id; Rugged Robotics' multi-checkbox group was
    // "plan said FILL but form still wants" because only its first,
    // unchecked box was read).
    const isChoice = (el) => ["radio", "checkbox"].includes((el.type || "").toLowerCase());
    const groupOf = (el) => {
      if (!isChoice(el)) return [el];
      try { return ns._learn.choiceGroup(el); } catch (e) { return [el]; }
    };
    const keyOfId = (id) => (String(id || "").match(/^(.*?)-labeled-(?:checkbox|radio)(?:-\d+)?$/) || [])[1] || id || "";
    const holds = (el) => {
      if ((el.type || "").toLowerCase() === "file") {
        return !!(el.files && el.files.length) || /\.(pdf|docx?|rtf|txt)\b/i.test(text(el.closest("div, fieldset")));
      }
      if (isChoice(el)) return groupOf(el).some((c) => c.checked);
      let read;
      try { read = ns._learn.readValue(el).value; } catch (e) { return true; }   // unreadable here: not claimed missing
      if (read === undefined) return true;
      if (Array.isArray(read)) return read.length > 0;
      return read !== null && String(read).trim() !== "";
    };
    const consider = (el, entry) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (isChoice(el)) for (const c of groupOf(el)) seen.add(c);
      const signals = signalsOf(el, entry);
      if (!signals.length) return;
      const flagged = signals.includes("aria-invalid");
      if (!flagged && holds(el)) return;
      invalid.push({
        id: entry ? entry.field_key : keyOfId(el.id), name: entry ? entry.field_key : (el.name || keyOfId(el.id)),
        label: labelOf(el, entry),
        message: flagged ? `invalid: ${messageOf(el) || "the form marked it"}` : `required (${signals.join(", ")})`,
      });
    };

    for (const entry of plan.entries) {
      if (entry.skipped || entry.satisfied_by) continue;
      let el = null;
      try { el = ns.locate(entry); } catch (e) { el = null; }
      consider(el, entry);
    }
    // Controls the plan did not know. A radio or checkbox group is one
    // question (its fieldset, or its first input, the rest marked seen);
    // an invisible decoy input is nobody's.
    for (const el of document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select')) {
      if (seen.has(el)) continue;
      const type = (el.type || "").toLowerCase();
      if (type === "radio" || type === "checkbox") {
        const group = el.closest("fieldset");
        if (group) { consider(group, null); seen.add(el); continue; }
        const members = groupOf(el);
        if (members.some((m) => seen.has(m))) { for (const m of members) seen.add(m); continue; }
        if (members[0] !== el) { seen.add(el); continue; }
      }
      if (el.tagName !== "FIELDSET" && el.offsetParent === null) { seen.add(el); continue; }
      // react-select's own internals: the typed input is judged through its
      // plan entry, and the `required` decoy beside it (`…-requiredInput`,
      // opacity 0, tabindex -1) has no label and no value by design. Live on
      // General Matter and Bitmovin (0.4.52) each surfaced as "INPUT · not in
      // plan" and inflated still_required.
      if (/requiredInput|select__input/.test(el.className || "") || el.getAttribute("aria-hidden") === "true"
          || (el.tabIndex < 0 && el.closest(".select__container"))) { seen.add(el); continue; }
      consider(el, null);
    }
    return { ok: true, invalid, blocked: [], submitButton: "(not clicked)" };
  }

  /**
   * What an Ashby form still wants, from the plan's required flags and the
   * page's current values — never from a submit click. Returns the same shape
   * as the dry run so the diff below reads it unchanged.
   */
  function localRequiredCheck(plan) {
    const invalid = [];
    for (const entry of plan.entries) {
      if (!entry.required || entry.skipped || entry.satisfied_by) continue;
      const container = document.querySelector(`[data-field-path="${CSS.escape(entry.field_key)}"]`);
      if (!container) continue;
      const file = container.querySelector('input[type="file"]');
      const control = container.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea, select');
      const choices = container.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      const pressed = container.querySelectorAll('button[aria-pressed="true"]');
      let holds;
      if (file) holds = (file.files && file.files.length > 0) || /\.(pdf|docx?|rtf|txt)\b/i.test(container.innerText);
      else if (control) holds = (control.value || "").trim() !== "";
      else if (pressed.length) holds = true;   // Ashby yes/no: a pressed button is the answer
      else if (choices.length) holds = Array.from(choices).some((c) => c.checked);
      else holds = false;
      if (!holds) invalid.push({ id: entry.field_key, name: entry.field_key, label: entry.label || entry.field_key, message: "required (Ashby form definition)" });
    }
    return { ok: true, invalid, blocked: [], submitButton: "(not clicked — Ashby)" };
  }

  // Pure pieces, for the node tests.
  ns._content = { missRow, scrubReason, pagePlanFor, domRequiredCheck, localRequiredCheck };

  /** A developer setting in chrome.storage.local, true only when set to exactly true. */
  async function devFlag(key) {
    try { const v = await chrome.storage.local.get(key); return v[key] === true; } catch (e) { return false; }
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

  // Ashby is a single-page app: "Apply" moves from /<org>/<id> to
  // /<org>/<id>/application without a load, and this script would never run
  // again. Watch the path and run once when the application form appears.
  if (window.location.host.endsWith("ashbyhq.com")) {
    let lastPath = window.location.pathname;
    setInterval(() => {
      const path = window.location.pathname;
      if (path === lastPath) return;
      lastPath = path;
      // Through the guard: Sierra ran twice when the path changed while
      // the first run was still filling, and the second run re-typed the
      // University field over its own answer.
      if (/\/application\/?$/.test(path)) ns.run();
    }, 500);
  }
})(FirstPlay);
