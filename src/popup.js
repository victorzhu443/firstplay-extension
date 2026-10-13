/**
 * Profile editor.
 *
 * The profile is pasted rather than synced because there is no account to sync
 * with: this browser holds the only stored copy (chrome.storage.local,
 * unencrypted), and the backend keeps nothing between requests. It is not
 * blind, though: the whole profile — protected answers and consents included —
 * travels to the configured backend with every plan and learn request, is used
 * for that request, and is not stored or logged there. Its non-protected parts
 * may go on to the model provider for bounded yes/no and option decisions;
 * protected answers and consents never do. docs/PRIVACY.md says the same.
 *
 * A module, so it shares config.js with the service worker: the backend the
 * popup describes is the one the worker sends the profile to (audit F16).
 * Content scripts stay classic (see extract.js); this page is loaded by
 * popup.html, not by the manifest, so a module is safe here.
 */
import { resolveBackend, atsOfHost, BACKEND_KEY, ALLOW_LOCAL_KEY } from "./config.js";

(function () {
  "use strict";

  const PROFILE_KEY = "firstplay.profile";
  const backendField = document.getElementById("backendUrl");
  const backendLine = document.getElementById("backendLine");
  const allowLocal = document.getElementById("allowLocal");

  // The worker's answer first (it holds the probe result that decides where
  // requests actually go); the same resolver here if the worker is asleep.
  async function resolvedBackend() {
    try {
      const r = await chrome.runtime.sendMessage({ kind: "backend" });
      if (r && r.url) return r;
    } catch (e) { /* worker not reachable: resolve here */ }
    return resolveBackend();
  }
  async function backendUrl() { return (await resolvedBackend()).url; }

  function showBackend(b) {
    const how = b.how === "stored" ? "the address you entered"
      : b.how === "local" ? "a backend on this machine, plain HTTP"
      : "the hosted backend, HTTPS";
    backendLine.textContent = `Your profile goes to ${b.host} (${how}) with every plan and learn request, and nowhere else.`;
    backendLine.className = "status" + (b.how === "local" ? " warn" : "");
  }
  resolvedBackend().then(showBackend).catch(() => { backendLine.textContent = "Could not resolve the backend."; });

  chrome.storage.local.get([BACKEND_KEY, ALLOW_LOCAL_KEY]).then((v) => {
    backendField.value = v[BACKEND_KEY] || "";
    allowLocal.checked = v[ALLOW_LOCAL_KEY] === true;
  });
  backendField.addEventListener("change", async () => {
    await chrome.storage.local.set({ [BACKEND_KEY]: backendField.value.trim() });
    location.reload();
  });
  allowLocal.addEventListener("change", async () => {
    await chrome.storage.local.set({ [ALLOW_LOCAL_KEY]: allowLocal.checked });
    location.reload();
  });

  const area = document.getElementById("profile");
  const saved = document.getElementById("saved");
  const state = document.getElementById("state");

  function describe(profile) {
    const sections = ["facts", "education", "legal_status", "preferences", "protected"];
    const filled = sections.reduce((total, name) => {
      const section = profile[name] || {};
      return total + Object.values(section).filter((v) => v).length;
    }, 0);

    return filled;
  }

  chrome.storage.local.get(PROFILE_KEY).then((stored) => {
    const profile = stored[PROFILE_KEY];

    if (profile && Object.keys(profile).length) {
      area.value = JSON.stringify(profile, null, 2);
      state.textContent = `Profile loaded — ${describe(profile)} answers stored.`;
      state.className = "status ok";
    } else {
      state.textContent = "No profile yet. Paste one below to get started.";
      state.className = "status warn";
    }
  });

  // Reported so a backend that is not running is distinguishable from a bug in
  // the extension — the two look identical from the page.
  backendUrl().then((base) => fetch(`${base}/api/autofill/health`))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((health) => {
      const model = health.model_available ? "model available" : "deterministic only";
      state.textContent += `  Backend up (${model}).`;
    })
    .catch(() => {
      state.textContent += "  Backend unreachable (the hosted one may be waking up — try again in a minute, or point to a local one below).";
      state.className = "status warn";
    });

  // Click-to-run. `activeTab` grants access to the current tab for this one
  // user gesture, which is the right shape for pages the manifest does not
  // match: employers embed Greenhouse forms on their own domains
  // (samsara.com/careers/…?gh_jid=…) — 31 of 55 live SWE-intern postings — and
  // enumerating those hosts is impossible. The alternative, <all_urls>, would
  // let the extension read every page visited, which is exactly the posture
  // this project keeps refusing.
  //
  // allFrames matters: Greenhouse's embed renders inside an iframe from
  // boards.greenhouse.io, where host permission already applies, so injecting
  // into every frame reaches the form where it lives — and ONLY there: the
  // content script fills nothing on a document that is not on an ATS origin,
  // and the worker refuses to inject the page-world filler into such a frame
  // (audit F3). On a page that is not an ATS origin the popup first says what
  // will happen and waits for a second click.
  const fillButton = document.getElementById("fill");
  const fillStatus = document.getElementById("fillStatus");
  const confirmBox = document.getElementById("fillConfirm");
  const confirmText = document.getElementById("fillConfirmText");
  let pendingFill = null;   // the tab a confirmation is waiting on

  function say(text, cls) { fillStatus.textContent = text; fillStatus.className = "status" + (cls ? ` ${cls}` : ""); }

  async function runFill(tab) {
    say("Running…");
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["src/extract.js", "src/fill.js", "src/learn.js", "src/content.js"],
      });
      // content.js auto-runs on first landing; on a page where it had already
      // run (an auto-matched host) this starts a fresh pass. run() is
      // single-flight, so a landing still in progress is left alone.
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: async () => (window.FirstPlay ? await window.FirstPlay.run() : null),
      });
      // One frame holds the form; a top frame that handed off reports so.
      const outcomes = (results || []).map((r) => r && r.result).filter((r) => r && typeof r === "object");
      const summary = outcomes.find((r) => "filled" in r);
      const handed = outcomes.find((r) => r.handedOff !== undefined);
      if (summary) {
        const parts = [`${summary.filled} filled in ${(summary.seconds || 0).toFixed(1)}s`];
        if (summary.failed) parts.push(`${summary.failed} known but not enterable — see orange notes on the page`);
        if (summary.review) parts.push(`${summary.review} need you (amber)`);
        if (summary.attach) parts.push(`${summary.attach} file(s) to attach`);
        if (summary.still_required != null) parts.push(`form still wants ${summary.still_required}`);
        say(parts.join(" · "), summary.failed ? "warn" : "ok");
      } else if (handed && handed.handedOff) {
        say(`The Greenhouse frame on ${handed.host} reported nothing — if the form is not open yet, click Apply and try again (details in the console, ⌥⌘J).`, "warn");
      } else if (handed) {
        say(`No Greenhouse form frame on ${handed.host} yet — click the employer's Apply button, then try again. Nothing was filled.`, "warn");
      } else {
        say("Ran, but found no form to fill on this page (details in the console, ⌥⌘J).", "warn");
      }
    } catch (e) {
      say(`Could not run here: ${e.message}`, "warn");
    }
  }

  /**
   * On a page that is not an ATS origin: read (never write) what the page
   * says about an embedded posting — the Greenhouse frame's own URL first,
   * the page's gh_jid and embed script as description — and ask.
   */
  async function describeAndConfirm(tab, host) {
    say("Looking at this page…");
    let results;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["src/extract.js"] });
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => (window.FirstPlay ? (window.FirstPlay.detectPosting() || window.FirstPlay.embeddedHint()) : null),
      });
    } catch (e) {
      say(`Could not look at this page: ${e.message}`, "warn");
      return;
    }
    const frames = (results || []).filter((r) => r && r.result && r.result.ats === "greenhouse" && r.result.embedded && r.frameId !== 0);
    const top = ((results || []).find((r) => r && r.frameId === 0) || {}).result || null;
    if (frames.length) {
      const f = frames[0].result;
      confirmText.textContent = `FirstPlay will fill the Greenhouse form embedded on ${host} for ${f.board}/${f.jobId}; ` +
        `nothing is sent to ${host} itself. Your answers and résumé go into that Greenhouse frame only, for you to review there.`;
      confirmBox.hidden = false;
      pendingFill = tab;
      say("");
      return;
    }
    const named = top && top.jobId
      ? ` This page names Greenhouse job ${top.jobId}${top.board ? ` on board ${top.board}` : ""}; click the employer's Apply button, then try again.`
      : " FirstPlay fills Greenhouse and Ashby application forms only.";
    say(`No Greenhouse form frame on ${host} yet — nothing was filled.${named}`, "warn");
  }

  fillButton.addEventListener("click", async () => {
    confirmBox.hidden = true; pendingFill = null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) { say("No active tab.", "warn"); return; }

    let host = "";
    try { host = new URL(tab.url || "").host; } catch (e) { host = ""; }
    if (atsOfHost(host)) { await runFill(tab); return; }
    await describeAndConfirm(tab, host || "this page");
  });
  document.getElementById("fillConfirmGo").addEventListener("click", async () => {
    const tab = pendingFill; pendingFill = null; confirmBox.hidden = true;
    if (tab) await runFill(tab);
  });
  document.getElementById("fillConfirmCancel").addEventListener("click", () => {
    pendingFill = null; confirmBox.hidden = true; say("Nothing was filled.");
  });

  // ----- resume: picked once here, stored as bytes in this browser only -----
  const RESUME_KEY = "firstplay.resume";
  const resumeStatus = document.getElementById("resumeStatus");

  function showResume(doc) {
    if (doc && doc.name) {
      resumeStatus.textContent = `Stored: ${doc.name} (${Math.round((doc.size || 0) / 1024)} KB)`;
      resumeStatus.className = "status ok";
    } else {
      resumeStatus.textContent = "No resume stored yet — choose the file you submit with applications.";
      resumeStatus.className = "status warn";
    }
  }

  chrome.storage.local.get(RESUME_KEY).then((stored) => showResume(stored[RESUME_KEY]));

  // Choosing the file is the whole gesture — it is stored the moment it is
  // picked, no second click.
  document.getElementById("resumeFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];

    if (!file) return;
    // chrome.storage.local holds ~10 MB; base64 adds a third. Real resumes
    // are a few hundred KB, so the cap only stops a mistaken pick.
    if (file.size > 6 * 1024 * 1024) {
      resumeStatus.textContent = "That file is over 6 MB — resumes are usually under 1 MB.";
      resumeStatus.className = "status warn";
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const doc = { name: file.name, type: file.type, size: file.size, data: btoa(binary),
                  stored_at: new Date().toISOString() };

    await chrome.storage.local.set({ [RESUME_KEY]: doc });
    showResume(doc);
  });

  document.getElementById("removeResume").addEventListener("click", async () => {
    await chrome.storage.local.remove(RESUME_KEY);
    showResume(null);
  });

  // ----- transcript: the same shape as the resume, its own slot -----
  const TRANSCRIPT_KEY = "firstplay.transcript";
  const transcriptStatus = document.getElementById("transcriptStatus");
  function showTranscript(doc) {
    if (doc && doc.name) {
      transcriptStatus.textContent = `Stored: ${doc.name} (${Math.round((doc.size || 0) / 1024)} KB)`;
      transcriptStatus.className = "status ok";
    } else {
      transcriptStatus.textContent = "No transcript stored — forms that ask for one will be outlined for you.";
      transcriptStatus.className = "status warn";
    }
  }
  chrome.storage.local.get(TRANSCRIPT_KEY).then((stored) => showTranscript(stored[TRANSCRIPT_KEY]));
  document.getElementById("transcriptFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      transcriptStatus.textContent = "That file is over 6 MB."; transcriptStatus.className = "status warn"; return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const doc = { name: file.name, type: file.type, size: file.size, data: btoa(binary), stored_at: new Date().toISOString() };
    await chrome.storage.local.set({ [TRANSCRIPT_KEY]: doc });
    showTranscript(doc);
  });
  document.getElementById("removeTranscript").addEventListener("click", async () => {
    await chrome.storage.local.remove(TRANSCRIPT_KEY); showTranscript(null);
  });

  // ----- learned from you: replayed answers, and facts proposed for your say-so -----
  const PROPOSALS_KEY = "firstplay.learning.proposals";
  const IGNORED_KEY = "firstplay.learning.ignored";
  const LEARNING_STATS_KEY = "firstplay.learning.stats";
  const SECTIONS = ["facts", "education", "legal_status", "preferences"];

  function placeLearned(profile, key, value) {
    // A proposal that names an existing (empty) profile key fills that key;
    // anything else lives under `learned`, which the backend reads like facts.
    for (const name of SECTIONS) {
      const section = profile[name];
      if (section && Object.prototype.hasOwnProperty.call(section, key) && !section[key]) {
        section[key] = value;
        return name;
      }
    }
    profile.learned = profile.learned || {};
    profile.learned[key] = value;
    return "learned";
  }

  document.getElementById("forgetPlans").addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ kind: "forgetPlans" });
    document.getElementById("forgetPlansNote").textContent = r && r.ok ? `forgot ${r.forgotten} plan(s); the next page plans afresh` : "could not";
  });

  // ----- fields it knew but could not enter: the diagnosis log -----
  const MISSES_KEY = "firstplay.misses";
  async function renderMisses() {
    const stored = await chrome.storage.local.get(MISSES_KEY);
    const rows = (stored[MISSES_KEY] || []).slice().reverse();
    document.getElementById("missesCount").textContent = String(rows.length);
    document.getElementById("missesList").textContent = rows.map((r) =>
      `${(r.at || "").slice(0, 16)} ${r.ats || "?"} ${r.where || ""}\n  ${r.state}: ${r.label}\n  ${r.why}`).join("\n\n") || "none so far";
  }
  renderMisses();
  document.getElementById("copyMisses").addEventListener("click", async () => {
    const stored = await chrome.storage.local.get(MISSES_KEY);
    const text = JSON.stringify(stored[MISSES_KEY] || [], null, 1);
    try { await navigator.clipboard.writeText(text); } catch (e) { /* ignore */ }
  });
  document.getElementById("clearMisses").addEventListener("click", async () => {
    await chrome.storage.local.set({ [MISSES_KEY]: [] }); renderMisses();
  });

  // The last run's record, as content.js stored it: values are already
  // absent (fieldRecord and scrubReason), so it can be pasted anywhere.
  const LAST_RECORD_KEY = "firstplay.lastRecord";
  const diagnosticsNote = document.getElementById("diagnosticsNote");
  chrome.storage.local.get(LAST_RECORD_KEY).then((v) => {
    const r = v[LAST_RECORD_KEY];
    diagnosticsNote.textContent = r ? `last run ${(r.at || "").slice(0, 16)} on ${r.where || "?"}` : "no run recorded yet";
  });
  document.getElementById("copyDiagnostics").addEventListener("click", async () => {
    const stored = await chrome.storage.local.get(LAST_RECORD_KEY);
    const record = stored[LAST_RECORD_KEY];
    if (!record) { diagnosticsNote.textContent = "no run recorded yet"; return; }
    try {
      await navigator.clipboard.writeText(JSON.stringify(record, null, 1));
      diagnosticsNote.textContent = "copied";
    } catch (e) { diagnosticsNote.textContent = "could not copy"; }
  });

  // Opt-in, off until the applicant turns it on: learning is a change in how
  // their data is handled after install, so it is disclosed and chosen here
  // (Chrome Web Store Limited Use; docs/research/learning-agents.md §4).
  const LEARN_ENABLED_KEY = "firstplay.learning.enabled";
  const learnToggle = document.getElementById("learnEnabled");
  chrome.storage.local.get([LEARN_ENABLED_KEY]).then((v) => { learnToggle.checked = !!v[LEARN_ENABLED_KEY]; });
  learnToggle.addEventListener("change", async () => {
    await chrome.storage.local.set({ [LEARN_ENABLED_KEY]: learnToggle.checked });
    renderLearned();
  });

  async function renderLearned() {
    const stored = await chrome.storage.local.get([PROFILE_KEY, PROPOSALS_KEY, LEARNING_STATS_KEY]);
    const profile = stored[PROFILE_KEY] || {};
    const proposals = stored[PROPOSALS_KEY] || [];
    const stats = stored[LEARNING_STATS_KEY] || {};
    const replayed = Object.keys(profile.answers || {}).length;
    const learned = Object.keys(profile.learned || {}).length;
    const status = document.getElementById("learnedStatus");
    const parts = [];
    parts.push(`${replayed} answer${replayed === 1 ? "" : "s"} of yours replayed on repeat questions`);
    if (learned) parts.push(`${learned} learned fact${learned === 1 ? "" : "s"}`);
    if (stats.sent) parts.push(`${stats.sent} observation${stats.sent === 1 ? "" : "s"} sent`);
    status.textContent = parts.join(" · ") + ".";
    status.className = "status" + (replayed || learned ? " ok" : "");

    const box = document.getElementById("proposals");
    const note = document.getElementById("proposalsNote");
    box.textContent = "";
    if (!proposals.length) {
      note.textContent = "When you answer or correct a field the fill left to you, that answer is remembered for the same question next time. Facts that look reusable show up here for you to accept.";
      return;
    }
    note.textContent = "Accept adds the fact to your profile; Ignore forgets the suggestion.";
    for (const proposal of proposals) {
      const card = document.createElement("div");
      card.className = "proposal";
      const q = document.createElement("div"); q.className = "q";
      q.textContent = proposal.label ? `Asked as: ${proposal.label.slice(0, 90)}` : "From your answers";
      const kv = document.createElement("div"); kv.className = "kv";
      const code = document.createElement("code"); code.textContent = proposal.key;
      kv.appendChild(code);
      kv.appendChild(document.createTextNode(` = ${Array.isArray(proposal.value) ? proposal.value.join(", ") : proposal.value}`));
      if (proposal.support > 1) kv.appendChild(document.createTextNode(` (seen ${proposal.support}×)`));
      const acts = document.createElement("div"); acts.className = "acts";
      const accept = document.createElement("button"); accept.textContent = "Accept";
      const ignore = document.createElement("button"); ignore.textContent = "Ignore";
      acts.appendChild(accept); acts.appendChild(ignore);
      card.appendChild(q); card.appendChild(kv); card.appendChild(acts);
      box.appendChild(card);

      accept.addEventListener("click", async () => {
        // The backend owns the promotion (it clears learned_pending and
        // knows which section the key lives in); the local write below is
        // the fallback when the backend is not running.
        let settled = false;
        try {
          const reply = await chrome.runtime.sendMessage({ kind: "learn", observations: [], accept: [proposal.key] });
          settled = !!(reply && reply.ok && (reply.accepted || []).includes(proposal.key));
        } catch (e) { settled = false; }
        const fresh = await chrome.storage.local.get([PROFILE_KEY, PROPOSALS_KEY]);
        const current = fresh[PROFILE_KEY] || {};
        if (!settled) placeLearned(current, proposal.key, proposal.value);
        const remaining = (fresh[PROPOSALS_KEY] || []).filter((p) => !(p.key === proposal.key && String(p.value) === String(proposal.value)));
        await chrome.storage.local.set({ [PROFILE_KEY]: current, [PROPOSALS_KEY]: remaining });
        area.value = JSON.stringify(current, null, 2);
        renderLearned();
      });
      ignore.addEventListener("click", async () => {
        const fresh = await chrome.storage.local.get([PROPOSALS_KEY, IGNORED_KEY]);
        const remaining = (fresh[PROPOSALS_KEY] || []).filter((p) => !(p.key === proposal.key && String(p.value) === String(proposal.value)));
        const ignored = fresh[IGNORED_KEY] || [];
        ignored.push({ key: proposal.key, value: proposal.value, at: new Date().toISOString() });
        await chrome.storage.local.set({ [PROPOSALS_KEY]: remaining, [IGNORED_KEY]: ignored.slice(-200) });
        renderLearned();
      });
    }
  }

  renderLearned();

  document.getElementById("save").addEventListener("click", async () => {
    let parsed;

    try {
      parsed = JSON.parse(area.value);
    } catch (e) {
      saved.textContent = `Not valid JSON: ${e.message}`;
      saved.className = "status warn";
      return;
    }

    await chrome.storage.local.set({ [PROFILE_KEY]: parsed });
    saved.textContent = `Saved — ${describe(parsed)} answers.`;
    saved.className = "status ok";
    try { await chrome.runtime.sendMessage({ kind: "forgetPlans" }); } catch (e) { /* ignore */ }
    renderEditor();
    renderAsks();
  });

  // ----- the profile, edited as a form instead of JSON -----
  //
  // The backend's onboarding registry (GET /api/autofill/profile-schema) is the
  // list of questions, in the order of how many application fields each one
  // answers. The editor writes only the keys the applicant changed, so
  // `answers`, `learned`, `learned_pending`, `skip` and anything else in the
  // stored profile survive untouched. Nothing but the schema GET leaves the
  // machine.
  const SECTION_TITLES = {
    facts: "About you", education: "Education", legal_status: "Work authorization",
    preferences: "Preferences", consents: "Standing consents", protected: "Self-identification (optional)",
  };
  const SECTION_ORDER = ["facts", "education", "legal_status", "preferences", "consents", "protected"];
  const CONSENT_CHOICES = ["", "Agree", "Yes", "No"];
  let schemaRows = null;      // null until fetched; [] when the fetch failed

  async function fetchSchema() {
    try {
      const base = await backendUrl();
      const res = await fetch(`${base}/api/autofill/profile-schema`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      schemaRows = Array.isArray(body.fields) ? body.fields : [];
    } catch (e) {
      schemaRows = [];
    }
    return schemaRows;
  }

  function sectionOf(profile, name) {
    if (!profile[name] || typeof profile[name] !== "object" || Array.isArray(profile[name])) profile[name] = {};
    return profile[name];
  }

  function fieldRow(row, current) {
    const wrap = document.createElement("div"); wrap.className = "field";
    const label = document.createElement("label");
    const code = document.createElement("code"); code.textContent = row.key.replace(/_/g, " ");
    label.appendChild(code);
    if (row.answers) label.appendChild(document.createTextNode(`  · answers ${row.answers} field${row.answers === 1 ? "" : "s"}`));
    wrap.appendChild(label);
    let input;
    if (row.section === "consents") {
      input = document.createElement("select");
      for (const choice of CONSENT_CHOICES) {
        const opt = document.createElement("option"); opt.value = choice; opt.textContent = choice || "— decide each time —";
        input.appendChild(opt);
      }
      if (current && !CONSENT_CHOICES.includes(current)) { const opt = document.createElement("option"); opt.value = current; opt.textContent = current; input.appendChild(opt); }
      input.value = current || "";
    } else {
      input = document.createElement("input"); input.type = "text";
      input.value = current || "";
      input.placeholder = row.example ? `e.g. ${row.example}` : "";
    }
    input.dataset.section = row.section; input.dataset.key = row.key; input.dataset.initial = current || "";
    wrap.appendChild(input);
    if (row.note) { const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = row.note; wrap.appendChild(hint); }
    return wrap;
  }

  async function renderEditor() {
    const editor = document.getElementById("editor");
    const note = document.getElementById("editorNote");
    const actions = document.getElementById("editorActions");
    if (schemaRows === null) await fetchSchema();
    const stored = await chrome.storage.local.get(PROFILE_KEY);
    const profile = stored[PROFILE_KEY] || {};
    editor.textContent = "";
    if (!schemaRows || !schemaRows.length) {
      note.textContent = "The backend is unreachable, so the question list could not be loaded — edit the raw profile below for now.";
      note.className = "status warn";
      actions.hidden = true;
      document.getElementById("rawBox").open = true;
      return;
    }
    note.textContent = "";
    actions.hidden = false;
    const bySection = new Map();
    for (const row of schemaRows) {
      if (!bySection.has(row.section)) bySection.set(row.section, []);
      bySection.get(row.section).push(row);
    }
    for (const name of SECTION_ORDER) {
      const rows = bySection.get(name);
      if (!rows) continue;
      const section = profile[name] || {};
      const filled = rows.filter((r) => section[r.key]).length;
      const box = document.createElement("details"); box.className = "section";
      box.open = name === "facts" && filled < rows.length / 2;
      const summary = document.createElement("summary");
      summary.textContent = `${SECTION_TITLES[name] || name} `;
      const count = document.createElement("span"); count.className = "count"; count.textContent = `${filled}/${rows.length} answered`;
      summary.appendChild(count);
      box.appendChild(summary);
      if (name === "protected") {
        const warn = document.createElement("p"); warn.style.fontSize = "11px"; warn.style.margin = "4px 0 6px";
        warn.textContent = "Replayed exactly as typed, never inferred, never sent to a model. Leave one empty to answer that question yourself each time.";
        box.appendChild(warn);
      }
      if (name === "consents") {
        const warn = document.createElement("p"); warn.style.fontSize = "11px"; warn.style.margin = "4px 0 6px";
        warn.textContent = "Standing decisions. Empty means the form leaves that box for you.";
        box.appendChild(warn);
      }
      for (const row of rows) box.appendChild(fieldRow(row, section[row.key]));
      editor.appendChild(box);
    }
  }

  document.getElementById("editorSave").addEventListener("click", async () => {
    const out = document.getElementById("editorSaved");
    const stored = await chrome.storage.local.get(PROFILE_KEY);
    const profile = stored[PROFILE_KEY] || {};
    let changed = 0;
    for (const input of document.querySelectorAll("#editor [data-key]")) {
      const value = (input.value || "").trim();
      if (value === (input.dataset.initial || "")) continue;
      sectionOf(profile, input.dataset.section)[input.dataset.key] = value;
      input.dataset.initial = value;
      changed += 1;
    }
    if (!changed) { out.textContent = "nothing changed"; out.className = "status"; return; }
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    area.value = JSON.stringify(profile, null, 2);
    try { await chrome.runtime.sendMessage({ kind: "forgetPlans" }); } catch (e) { /* ignore */ }
    out.textContent = `saved ${changed} change${changed === 1 ? "" : "s"} — the next page plans afresh`;
    out.className = "status ok";
    state.textContent = `Profile loaded — ${describe(profile)} answers stored.`;
    renderEditor();
  });

  // ----- questions from the last page -----
  const ASKS_KEY = "firstplay.asks";
  const ASKS_SKIPPED_KEY = "firstplay.asks.skipped";

  async function saveAsk(ask, value) {
    const stored = await chrome.storage.local.get([PROFILE_KEY, ASKS_KEY]);
    const profile = stored[PROFILE_KEY] || {};
    sectionOf(profile, ask.section)[ask.key] = value;
    const remaining = (stored[ASKS_KEY] || []).filter((a) => !(a.section === ask.section && a.key === ask.key));
    await chrome.storage.local.set({ [PROFILE_KEY]: profile, [ASKS_KEY]: remaining });
    area.value = JSON.stringify(profile, null, 2);
    state.textContent = `Profile loaded — ${describe(profile)} answers stored.`;
  }

  async function skipAsk(ask) {
    const stored = await chrome.storage.local.get([ASKS_KEY, ASKS_SKIPPED_KEY]);
    const remaining = (stored[ASKS_KEY] || []).filter((a) => !(a.section === ask.section && a.key === ask.key));
    const skipped = (stored[ASKS_SKIPPED_KEY] || []).filter((s) => !(s.section === ask.section && s.key === ask.key));
    skipped.push({ section: ask.section, key: ask.key, at: Date.now() });
    await chrome.storage.local.set({ [ASKS_KEY]: remaining, [ASKS_SKIPPED_KEY]: skipped.slice(-200) });
  }

  async function renderAsks() {
    const box = document.getElementById("asksBox");
    const list = document.getElementById("asksList");
    const title = document.getElementById("asksTitle");
    const noteEl = document.getElementById("asksNote");
    const stored = await chrome.storage.local.get([ASKS_KEY, PROFILE_KEY]);
    const profile = stored[PROFILE_KEY] || {};
    // An ask the profile has since answered (through the editor, or a paste) is settled.
    const asks = (stored[ASKS_KEY] || []).filter((a) => !((profile[a.section] || {})[a.key]));
    if (asks.length !== (stored[ASKS_KEY] || []).length) await chrome.storage.local.set({ [ASKS_KEY]: asks });
    list.textContent = "";
    if (!asks.length) { box.hidden = true; return; }
    box.hidden = false;
    title.textContent = `This page asked for ${asks.length} thing${asks.length === 1 ? "" : "s"} your profile doesn't have`;
    const inputs = [];
    for (const ask of asks) {
      const card = document.createElement("div"); card.className = "ask";
      const q = document.createElement("div"); q.className = "q";
      q.textContent = (ask.label || ask.prompt || ask.key) + (ask.required ? "  (required there)" : "");
      card.appendChild(q);
      if (ask.pages > 1) { const seen = document.createElement("div"); seen.className = "hint"; seen.textContent = `asked on ${ask.pages} pages`; card.appendChild(seen); }
      if (ask.section === "protected") {
        const warn = document.createElement("div"); warn.className = "hint";
        warn.textContent = "Self-identification: stored exactly as typed, never inferred. Skip to keep answering it yourself.";
        card.appendChild(warn);
      }
      const field = document.createElement("div"); field.className = "field";
      const label = document.createElement("label");
      const code = document.createElement("code"); code.textContent = `${ask.section}.${ask.key}`;
      label.appendChild(code); field.appendChild(label);
      const input = document.createElement("input"); input.type = "text"; input.placeholder = ask.example ? `e.g. ${ask.example}` : "";
      field.appendChild(input);
      if (ask.note) { const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = ask.note; field.appendChild(hint); }
      card.appendChild(field);
      const acts = document.createElement("div"); acts.className = "acts";
      const save = document.createElement("button"); save.textContent = "Save";
      const skip = document.createElement("button"); skip.textContent = "Skip";
      acts.appendChild(save); acts.appendChild(skip); card.appendChild(acts);
      list.appendChild(card);
      inputs.push({ ask, input });
      save.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!value) { noteEl.textContent = "type an answer first, or Skip"; noteEl.className = "status warn"; return; }
        await saveAsk(ask, value);
        try { await chrome.runtime.sendMessage({ kind: "forgetPlans" }); } catch (e) { /* ignore */ }
        noteEl.textContent = "saved — reopen the page to fill it"; noteEl.className = "status ok";
        renderAsks(); renderEditor();
      });
      skip.addEventListener("click", async () => { await skipAsk(ask); renderAsks(); });
    }
    document.getElementById("asksSaveAll").onclick = async () => {
      let n = 0;
      for (const { ask, input } of inputs) {
        const value = input.value.trim();
        if (!value) continue;
        await saveAsk(ask, value); n += 1;
      }
      if (n) { try { await chrome.runtime.sendMessage({ kind: "forgetPlans" }); } catch (e) { /* ignore */ } }
      noteEl.textContent = n ? `saved ${n} — reopen the page to fill them` : "nothing typed";
      noteEl.className = n ? "status ok" : "status warn";
      renderAsks(); renderEditor();
    };
  }

  renderAsks();
  renderEditor();
})();
