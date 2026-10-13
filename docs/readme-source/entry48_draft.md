**48. The outside audit, round two: no page but the form's own, no Submit
pressed, no value in any log (2026-10-12, extension 0.4.52, backend
DECISIONS §57).**
*Why.* The full codebase audit (CODE_AUDIT_REPORT.md) left the extension
with two High findings and a cluster of Mediums that were all about the
same thing: where the applicant's data could go that the documents said it
could not. F3: `detectPosting` accepted any host *ending in*
`greenhouse.io` or `ashbyhq.com` and any page carrying `?gh_jid=` plus an
embed script tag, so one click on *Fill this page* on a crafted careers
page built a plan from the real board's schema, wrote name, contact
details and EEO answers into whatever controls carried the field ids, and
attached the résumé bytes to any file input (probe p02). F4: "never
submits" rested on a dry run that pressed the real Submit button inside a
four-second monkeypatch of `fetch`, XHR, `sendBeacon` and `form.submit`;
a page holding its own reference to `fetch` would have posted, and of 368
survey rows none had ever shown the block firing. F6: the misses log the
popup copies out stored the widget's reason with the refused value
quoted inside it, against PRIVACY.md. F7: the learning loop filtered
protected questions by vendor key and two reason strings, so a
custom-keyed "race or ethnicity" question was captured and sent to
/learn. F16: two backend selectors — the worker probed `localhost:8000`
silently over plain HTTP and used whatever answered, while the popup
described Render. F17: the previous plan's stored location was typed into
the next Ashby page's geocoder before that page's plan existed, and Ashby
autosaves drafts. F21: a failed model path was indistinguishable from no
call, and the run record did not say which backend, engine or world
served it.
*What changed.* Hosts are matched exactly — `job-boards.greenhouse.io`,
`boards.greenhouse.io`, `jobs.ashbyhq.com`, and the vendors' own
subdomains only — in the content script and, separately, in the worker,
which now refuses to inject the page-world filler, warm, or click for any
frame not on an ATS origin; a node test holds the two matchers to the same
vectors. On an employer's own page the content script hands off to the
`boards.greenhouse.io/embed/job_app` frame, where its own copy fills as it
always did (the 31-of-55 embedded postings), and the popup first reads
the page and says "FirstPlay will fill the Greenhouse form embedded on
<host> for <board>/<job>; nothing is sent to <host> itself", then waits
for a second click. No board is guessed from a domain any more. The
Submit click is gone from the default path on both vendors: what the form
still wants is read from the plan's required flags and the DOM's own
signals (`required`, `aria-required`, the `*` label, any `aria-invalid`
the form set) against what each control holds; the click survives only
behind a developer setting, `firstplay.dryRun.click`, never on a form
that reads complete, and a click that blocks nothing and flags nothing is
recorded as `dry_run_bypassed`. The misses row is scrubbed like the run
record. The learning capture excludes any entry whose reason names a
protected profile key, and any entry the backend stamps `protected` or
`field_class: legal|consent`. One `resolveBackend()` in config.js serves
the worker and the popup (now a module); the localhost probe runs only
behind a popup toggle, off by default; the popup prints where the profile
goes. `warm()` starts Greenhouse loader reads only. The run record gains
`engine`, `backend` (host), `world`, `cache_hit`, the model flags,
`model_failed`/`model_error` when the backend sends them, `check_mode`,
`submit_clicked`, `blocked`, `dry_run_bypassed` and `dom_wants`; the popup
exports it with *Copy diagnostics*.
*Measured.* Node tests 2 files → 4 (`content.test.mjs` loads the real
fill.js and content.js; `extract.test.mjs` rejects p02's three detections
and accepts the legitimate hosts and the embed frame), all green; p02
against 0.4.52 prints `null` three times. Live, on 0.4.52 with the window
on screen: [N] fresh Greenhouse boards and [N] Ashby orgs ran with
`check_mode: "dom"` and `submit_clicked: false` in every record, [N] of
them with `still_required: 0`; on [N] boards the developer click mode was
turned on for one run each and `wants` was compared with `dom_wants` —
[N] rows agreed, [N] the form flagged that the DOM check did not
([which: format rules / conditional requirements / wrapper-state]), [N]
the other way; [N] employer-hosted embeds (Samsara, Lyft, …) filled inside
the frame after the popup's confirmation, with the top document holding
[0] of the plan's values; the fill's instant tier stayed at [N] ms median
([N] boards). Still owed by the backend: `field_class` on every plan
entry, so the capture's protected filter stops depending on reason
wording.
