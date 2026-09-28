# FirstPlay Autofill — Chrome extension

Fills job application forms from answers you have already given. Reviews before
you submit, and never submits for you.

## What it does and does not do

The extension is deliberately thin. It reads the form, asks the backend what to
put in it, writes the values, and highlights them. **Every decision is made in
Python**, where it is covered by 544 tests — nothing here interprets a question
or chooses an answer.

Your profile lives in `chrome.storage.local` on this machine. The backend is
stateless: it receives the profile with a request, resolves a form, and stores
nothing. There is no account, because there is nothing server-side to protect.

## Install (unpacked)

1. Start the backend:

   ```bash
   cd ../firstplay-backend
   uvicorn app.main:app --reload
   ```

2. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select this directory.

3. Click the extension icon and paste the contents of
   `~/.config/firstplay/profile.json`, then **Save profile**.

4. Open a Greenhouse or Ashby application page and check the console
   (`⌥⌘J`) for the plan.

## Status: iteration 3

Reads the form, fetches a plan, and writes it into the page. Every touched
field is outlined: **green** filled, **amber** needs you, **dashed blue** attach
a file. Hover any outline for the reason. Submit is never touched.

| | |
|---|---|
| ✅ Detects Greenhouse and Ashby postings |
| ✅ Reads controls, collapsing radio groups into one question |
| ✅ Fetches Greenhouse's authoritative schema from its public API |
| ✅ Requests a plan and logs it, with cost and model-call count |
| ✅ Writes text values through React's native setter |
| ✅ Drives Greenhouse dropdowns via react-select's `selectOption`, with readback |
| ✅ Outlines every field by outcome; hover shows the reason |
| ✅ Reports plan entries the page does not actually render |
| ✅ Click-to-run from the popup, via `activeTab` — this tab, this click only |
| ✅ Employer-hosted Greenhouse postings (`?gh_jid=`): board inferred from the domain or embed script, verified against the API |
| ✅ Runs inside Greenhouse's `embed/job_app` iframe (`all_frames`); the top frame steps aside |
| ✅ Drives button-and-listbox dropdowns (Duolingo's own renderer), with a deselect guard; one bad control no longer aborts the rest |
| ✅ Ashby: reads question text from the field container (radio groups and lone checkboxes now labelled), groups checkbox options into one question, drives the Location autocomplete |
| ✅ Greenhouse education block (36/57 corpus postings): school / degree / discipline / end date answered from your profile; async react-selects driven through their loader |
| ✅ Greenhouse "Voluntary Self Identification" block (12/57): replayed where your stored answer is unambiguous, otherwise outlined for you |
| ✅ Duolingo's own School/Degree/Discipline comboboxes: types into the focusable twin input, opens it with an explicit `focusin`, picks the suggestion |
| ✅ When an answer is known but the widget won't take it: orange note with the value beside the field, count in the popup |
| ✅ Location (required on 57/57 corpus postings): geocoder typeahead driven on both renderers, exact suggestion picked, hidden lat/long filled by the page |
| ✅ Resume: upload it once in the popup; it is stored in this browser's extension storage and attached to every form as a real file upload |
| ✅ Entries answered by a sibling / made inapplicable are never written (a leftover "Yes" was being filled) |
| ✅ Inapplicable follow-ups select the form's N/A option; remaining single-choice screening questions get a bounded, confidence-gated model answer from your profile |
| ⬜ Sends your corrections back as remembered answers |

## Two ways it runs

**Automatically** on `job-boards.greenhouse.io`, `boards.greenhouse.io` and
`jobs.ashbyhq.com` — the hosts the manifest matches.

**On click**, anywhere else: open the popup and press **Fill this page**. This
uses `activeTab`, which grants access to the current tab for that one gesture
and nothing more. It exists because employers host Greenhouse postings on their
own domains (`careers.duolingo.com/jobs/…?gh_jid=…`) — 31 of 57 live SWE-intern
postings measured — and those hosts cannot be enumerated. The alternative,
`<all_urls>`, would let the extension read every page you visit; this project
keeps declining that trade.

Three of those 31 were opened live, and they render three different ways
(`docs/DECISIONS.md` §20):

- **Duolingo** serves the Greenhouse form directly on its own domain. Click
  **Fill this page**; the board is inferred from the domain and checked against
  the API before anything is filled.
- **Lyft** (`app.careerpuck.com`) shows nothing until you click the site's
  **Apply** button; the form then arrives in a `job-boards.greenhouse.io`
  iframe, which is a matched host, so it fills **automatically** — no popup
  needed.
- **Samsara**'s embed never rendered at all in our measurements (empty
  `#grnhse_app` before and after Apply Now). Nothing to fill; open the posting
  elsewhere if you can.

If the popup says the board could not be inferred, the domain and board token
differ; open the posting on `job-boards.greenhouse.io` instead.

## Notes for whoever edits this next

- **Content scripts are classic scripts.** An `export` in one is a syntax error
  at load and the script silently never runs, which looks exactly like the
  extension not being installed. Only `background.js` is a module.
- **Network calls go in the service worker.** A fetch from a content script
  carries the page's origin and is subject to CORS; the worker holds host
  permission and is exempt.
- **Radio inputs sharing a `name` are one question.** Each is labelled with its
  own option rather than the question, and real Ashby forms have no legend — so
  reading them separately turns one protected-characteristic question into eight
  fields that no safety rule recognises.
- **Passwords are never read.** Not extracted, not sent, not filled.
- **Dropdowns cannot be opened synthetically.** Greenhouse controls
  `menuIsOpen` from its wrapper, so no event or instance method opens the menu.
  Selection goes through the react-select instance's `selectOption`, found via
  the fiber tree, and is read back from the displayed value. See
  `docs/DECISIONS.md` §16 in the backend for the measurements.
- **Ashby renders its demographics section late.** A single read at
  `document_idle` misses it, so the content script samples the control count
  until it stops changing. Do not force it by scrolling to the bottom — that
  froze the renderer on a live posting.
- **Greenhouse's phone widget strips the dashes** you type, so a filled
  "301-906-3249" reads back as "3019063249". That is the same number, not a
  failed fill.
- **File inputs cannot be set by any script.** The résumé is outlined dashed
  blue with its path; you attach it.
