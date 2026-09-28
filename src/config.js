// Where the resolver lives. Everything that decides anything runs there; this
// extension only reads the page and writes to it.
export const BACKEND = "http://localhost:8000";

// Storage keys. The profile lives here and nowhere else — the backend is
// stateless by design, so this is the only copy and it stays on this machine.
export const PROFILE_KEY = "firstplay.profile";
