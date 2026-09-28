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
        files: ["src/extract.js", "src/fill.js", "src/content.js"],
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
