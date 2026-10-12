// Where the resolver lives. Everything that decides anything runs there; this
// extension only reads the page and writes to it. The hosted backend is the
// default so a person can install the extension and use it with nothing else
// to run; it is stateless (the profile travels with each request and is kept
// nowhere). A local backend can be chosen in the popup for development or
// for keeping every request on this machine.
export const HOSTED_BACKEND = "https://firstplay-backend.onrender.com";
export const LOCAL_BACKEND = "http://localhost:8000";
export const BACKEND_KEY = "firstplay.backend";
export const INSTALL_KEY = "firstplay.install";

let localProbe = null;   // one probe per worker lifetime: is a local backend running?

/**
 * The backend to use right now: the popup's choice if set; otherwise a local
 * backend when one answers on :8000 (development, or someone who prefers to
 * keep requests on their machine); otherwise the hosted one.
 */
export async function backendUrl() {
  try {
    const stored = await chrome.storage.local.get(BACKEND_KEY);
    const chosen = (stored[BACKEND_KEY] || "").trim().replace(/\/+$/, "");
    if (/^https?:\/\//.test(chosen)) return chosen;
  } catch (e) { /* storage unavailable: fall through */ }
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
  return (await localProbe) ? LOCAL_BACKEND : HOSTED_BACKEND;
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

// Storage keys. The profile lives here and nowhere else — the backend is
// stateless by design, so this is the only copy and it stays on this machine.
export const PROFILE_KEY = "firstplay.profile";
