/**
 * Profile editor.
 *
 * The profile is pasted rather than synced because there is no account to sync
 * with: the backend stores nothing, so this browser holds the only copy. That is
 * the whole privacy posture in one design choice — protected characteristics and
 * a home postcode never sit on a server.
 *
 * Classic script (popup scripts may be modules, but keeping every non-worker
 * script classic removes one way to get the manifest wrong).
 */
(function () {
  "use strict";

  const PROFILE_KEY = "firstplay.profile";
  const BACKEND = "http://localhost:8000";

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
  fetch(`${BACKEND}/api/autofill/health`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((health) => {
      const model = health.model_available ? "model available" : "deterministic only";
      state.textContent += `  Backend up (${model}).`;
    })
    .catch(() => {
      state.textContent += "  Backend unreachable — start it on :8000.";
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
  // allFrames matters: Greenhouse's embed can render inside an iframe from
  // boards.greenhouse.io, where host permission already applies, so injecting
  // into every frame reaches the form wherever it lives.
  document.getElementById("fill").addEventListener("click", async () => {
    const status = document.getElementById("fillStatus");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      status.textContent = "No active tab.";
      status.className = "status warn";
      return;
    }

    status.textContent = "Running…";
    status.className = "status";

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
      // One frame holds the form; the others report nothing.
      const summary = (results || []).map((r) => r && r.result).find((r) => r && typeof r === "object");
      if (summary) {
        const parts = [`${summary.filled} filled in ${(summary.seconds || 0).toFixed(1)}s`];
        if (summary.failed) parts.push(`${summary.failed} known but not enterable — see orange notes on the page`);
        if (summary.review) parts.push(`${summary.review} need you (amber)`);
        if (summary.attach) parts.push(`${summary.attach} file(s) to attach`);
        if (summary.still_required != null) parts.push(`form still wants ${summary.still_required}`);
        status.textContent = parts.join(" · ");
        status.className = summary.failed ? "status warn" : "status ok";
      } else {
        status.textContent = "Ran, but found no form to fill on this page (details in the console, ⌥⌘J).";
        status.className = "status warn";
      }
    } catch (e) {
      status.textContent = `Could not run here: ${e.message}`;
      status.className = "status warn";
    }
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
  });
})();
