// Where the resolver lives. Everything that decides anything runs there; this
// extension only reads the page and writes to it. The hosted backend is the
// default so a person can install the extension and use it with nothing else
// to run. It is stateless, not blind: the whole profile travels with every
// plan and learn request, is used for that request, and is not stored or
// logged there; its non-protected parts may go on to the model provider. A
// local backend can be chosen in the popup for development or for keeping
// every request on this machine (docs/PRIVACY.md).
//
// This module is the ONE place the backend is chosen: the service worker
// imports it, and so does the popup, so what the popup shows is what the
// worker sends the profile to (audit F16: two selectors disagreed, and the
// worker could be talking to a local port while the popup described Render).
export const HOSTED_BACKEND = "https://firstplay-backend.onrender.com";
export const LOCAL_BACKEND = "http://localhost:8000";
export const BACKEND_KEY = "firstplay.backend";
//: Opt-in, off by default: may the worker look for a backend on this
//: machine? Until it is on, nothing is ever sent to localhost unless the
//: applicant typed that address into the backend field themselves.
export const ALLOW_LOCAL_KEY = "firstplay.backend.allowLocal";
export const INSTALL_KEY = "firstplay.install";

let localProbe = null;   // one probe per worker lifetime: is a local backend running?

// A changed choice must not be served from the old probe.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[BACKEND_KEY] || changes[ALLOW_LOCAL_KEY])) localProbe = null;
  });
} catch (e) { /* no storage events here */ }

/**
 * The backend in use right now, with how it was chosen:
 *
 *   { url, host, how }   how ∈ "stored" | "local" | "hosted"
 *
 * The popup's explicit address wins ("stored"). Otherwise, only when the
 * applicant turned the local option on, a backend answering on :8000 is
 * used ("local"; plain HTTP, this machine only). Otherwise the hosted one.
 */
export async function resolveBackend() {
  let stored = {};
  try { stored = await chrome.storage.local.get([BACKEND_KEY, ALLOW_LOCAL_KEY]); } catch (e) { /* storage unavailable: fall through */ }
  const chosen = (stored[BACKEND_KEY] || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(chosen)) return describe(chosen, "stored");
  if (stored[ALLOW_LOCAL_KEY] === true) {
    if (localProbe === null) {
      localProbe = (async () => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 400);
          const res = await fetch(`${LOCAL_BACKEND}/api/autofill/health`, { cache: "no-store", signal: controller.signal });
          clearTimeout(timer);
          return res.ok;
        } catch (e) { return false; }
      })();
    }
    if (await localProbe) return describe(LOCAL_BACKEND, "local");
  }
  return describe(HOSTED_BACKEND, "hosted");
}

function describe(url, how) {
  let host = url;
  try { host = new URL(url).host; } catch (e) { /* keep the text */ }
  return { url, host, how };
}

/** The backend URL to send to right now (see resolveBackend). */
export async function backendUrl() {
  return (await resolveBackend()).url;
}

/**
 * A random token minted on first run and sent with every backend request as
 * X-FirstPlay-Install, so the hosted backend can rate-limit per install
 * rather than per shared address. It is not tied to the person or the profile.
 */
export async function installToken() {
  const stored = await chrome.storage.local.get(INSTALL_KEY);
  if (stored[INSTALL_KEY]) return stored[INSTALL_KEY];
  const token = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  await chrome.storage.local.set({ [INSTALL_KEY]: token });
  return token;
}

/**
 * Which ATS a host belongs to — exactly: the vendors' application hosts by
 * name, plus proper subdomains of their apex domains (the EU boards). The
 * same rule as extract.js's atsOfHost (content scripts are classic and
 * cannot import this module); tests/extract.test.mjs holds the two to the
 * same vectors. The worker uses it to refuse page-world injection, the warm
 * step and the dry run for any frame that is not on an ATS origin (F3).
 */
const GREENHOUSE_HOSTS = ["job-boards.greenhouse.io", "boards.greenhouse.io"];
const ASHBY_HOSTS = ["jobs.ashbyhq.com"];

function hostIs(host, names, apex) {
  host = String(host || "").toLowerCase();
  return names.includes(host) || host.endsWith("." + apex);
}

export function atsOfHost(host) {
  if (hostIs(host, GREENHOUSE_HOSTS, "greenhouse.io")) return "greenhouse";
  if (hostIs(host, ASHBY_HOSTS, "ashbyhq.com")) return "ashby";
  return null;
}

/** The ATS of a URL's host, or null; a malformed URL is nobody's. */
export function atsOfUrl(url) {
  try { return atsOfHost(new URL(url).host); } catch (e) { return null; }
}

// Storage keys. The profile's only stored copy is here (chrome.storage.local,
// unencrypted); the backend is stateless by design and keeps none. It leaves
// this machine in transit, with every request to the backend.
export const PROFILE_KEY = "firstplay.profile";
