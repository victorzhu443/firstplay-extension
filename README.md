# FirstPlay Autofill — Chrome extension

Fills job applications from answers you have already given, on the real form,
in about two seconds. You review what it wrote and you press Submit. **It never
submits for you.**

Measured on **69 live Greenhouse postings** (unseen boards, drawn fresh for
every round): **1075 fields filled**, **21 cases** where it knew the answer but
could not enter it, both on boards whose defect is fixed below. The rest of what
a form still asks for after a fill is essays, consent boxes and one-off
questions ("which office?", "can you lift 50 lb?") that no profile answers.

The companion backend, which makes every decision, is
[firstplay-backend](https://github.com/victorzhu443/firstplay-backend) — its
`docs/DECISIONS.md` records each of the choices below with the measurement
behind it (section numbers are cited as §N).

---

## 1. Using it

### What you need

- Chrome (Manifest V3, developer mode).
- The backend running locally on port 8000. It is stateless: it receives your
  profile with each request, resolves the form, stores nothing.
- A profile — your name, contact details, education, work authorisation,
  preferences, and the protected-characteristic answers you *choose* to store.
- Your résumé as a PDF.

### Setup, once

1. **Start the backend.**

   ```bash
   cd firstplay-backend
   .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```

2. **Build your profile.** The backend has an interactive setup that asks for
   each fact in order of how many real application fields it answers, so
   stopping early still leaves a useful profile:

   ```bash
   .venv/bin/python -m app.autofill.setup
   ```

   It writes `~/.config/firstplay/profile.json` — outside any repository on
   purpose, since it holds your phone number, address and self-identification
   answers.

3. **Load the extension.** Open `chrome://extensions`, turn on **Developer
   mode**, click **Load unpacked**, choose this folder.

4. **Give it your profile.** Click the extension icon, paste the contents of
   `profile.json` into the box, press **Save profile**. It lives in
   `chrome.storage.local` on this machine and nowhere else.

5. **Give it your résumé.** In the same popup, choose the file. It is stored
   the moment you pick it (no Save button) and attached to every form as a real
   file upload. ✕ forgets it. Files over 6 MB are refused.

### Every application after that

1. Open a posting on `job-boards.greenhouse.io`, `job-boards.eu.greenhouse.io`,
   `boards.greenhouse.io` or `jobs.ashbyhq.com`. The fill starts by itself.
2. **Keep the Chrome window on screen.** Greenhouse does not finish building
   its form while the tab is hidden, and macOS reports a window covered by
   another window as hidden. A posting opened in a background tab fills the
   moment you look at it (§37).
3. Read the outlines:

   | outline | meaning |
   |---|---|
   | **green** | filled from your profile; hover for the reason |
   | **amber** | needs you — nothing stored answers it, or it is an essay or a consent |
   | **dashed blue** | attach this file yourself (only when the résumé is not stored) |
   | **orange note beside a field** | the answer is known but the widget would not take it — a defect, please report it with the console log |

4. The popup shows one line: `18 filled in 2.1s · 4 need you · form still wants 4`.
   The last number is the form's own opinion: after every fill the extension
   presses Submit in a **dry run** — every network write is blocked — and reads
   which fields the form marks invalid (§32). Those are what stands between
   you and submission.
5. Fill the amber fields, check the green ones, press Submit yourself.

### Employer-hosted postings

Employers embed Greenhouse on their own domains (31 of 57 SWE-intern postings
measured, §20). Those hosts cannot be enumerated, and `<all_urls>` would let the
extension read every page you visit, so it does not ask for that. Instead:

- If the form arrives in a `job-boards.greenhouse.io` iframe (Lyft's
  careerpuck page), it fills automatically — the frame is a matched host.
- If the form is served directly on the employer's domain (Duolingo), open the
  popup and press **Fill this page**. This uses `activeTab`: access to this
  tab, for this click, and nothing more. The board is inferred from the domain
  or the embed script and verified against Greenhouse's API before anything is
  written.

### Reading the console (⌥⌘J)

Every run logs, in order: the posting and plan summary with model-call count
and cost; `applied: N filled, …`; `timing: page settled · plan ready · filled ·
total`; then one `form wants: <field> ⇐ plan said <what>` line per field the
dry-run submit rejected. `plan said FILL` on such a line means the filler
failed — that is the line to paste into a bug report. The full plan is on
`window.__firstplayPlan` and the outcome on `window.__firstplayOutcome`.

---

## 2. What it fills

Every decision is made in Python, covered by 565 offline tests. The extension
reads the form, asks for a plan, writes the values, highlights them, and asks
the form what is still missing. Nothing here interprets a question.

| block | how it is answered | share of postings |
|---|---|---|
| Name, email, phone, links, location | stored facts; location through Greenhouse's geocoder typeahead, exact suggestion picked, hidden lat/long filled by the page | location required on 57/57 |
| Country, state, city, street address | derived from the stored location; street address only if stored | — |
| Résumé | stored file attached through a real file-input drop | — |
| Education (school, degree, discipline, start/end month and year) | stored education; async selects driven through their loader, exact option only | 36/57 |
| Work authorisation, sponsorship | per-country stored facts | ~136 + ~101 of 1,010 screening fields |
| "Worked here before?", "How did you hear about us?" | computed from employment history; stored preference; "Careers Website" maps to the employer's own site option | ~109 + 78 |
| Voluntary self-identification (EEO, veteran, disability), incl. Greenhouse's two-question race block | replayed from stored answers only when the option matches exactly; **never** inferred by a model | 12/57 |
| Inapplicable follow-ups ("If so, are you eligible for OPT?") | the form's N/A option is selected; a *required* follow-up with no N/A keeps a truthful answer of its own or is outlined for you, never left blank | — |
| Remaining single-choice screening questions | a bounded model decision (TypeSafe Jev) from your non-protected profile, accepted only at ≥ 0.85 confidence and labelled as such | 4.1% of filled values |
| Essays, consents, AI-use attestations | left for you, by decision (§14, §21) | — |

---

## 3. The iterations, and what each one taught

Every version below was a defect found on a real posting, diagnosed with a
measurement, fixed, and re-tested on postings not seen before. Each shipped as
its own pull request with a DECISIONS entry.

### Where it started (0.4.3)

Read the form, fetch a plan, write text through React's native value setter,
drive Greenhouse dropdowns through the react-select instance found on the
fiber tree (`selectOption`), outline everything. Worked on the one Duolingo page
it was built against.

### 0.4.4 – 0.4.5 · Speed (§29)

- **Symptom.** "If it is slower than by hand then what is the point." The
  Duolingo form took 30+ s; the applicant expected ~10 ms per option.
- **Diagnosis.** Timed each phase. The plan was requested only after the page
  "settled"; every select was driven one after another, each waiting on its
  own async loader; polls ran every 250 ms.
- **Fix.** Request the plan before the page settles and cache it per session
  (posting + profile hash). Fill in tiers: instant values first, then start
  every lookup (education, location) at once, then pick. 40 ms polls. A
  `timing:` line so the number is always visible.
- **Result.** Duolingo full form in ~2 s.

### 0.4.6 · Coinbase's dropdowns offered a phone-country list (§30)

- **Symptom.** On Coinbase's embed, school and degree dropdowns were filled
  from the wrong list.
- **Diagnosis.** Two races. The filler wrote before React had hydrated the
  widget; and the search for a widget's suggestion list walked up the DOM
  without bound and found the phone widget's list.
- **Fix.** Wait for each select to have a React instance before driving it;
  bound the list search to three ancestors and never a box holding more than
  two inputs.

### 0.4.7 · The two-question EEO race block (§31)

A structural survey of ten boards showed Greenhouse renders race as
"Hispanic/Latino? yes/no" that reveals a second select. The stored race now
answers both, in order, waiting for the reveal.

### 0.4.8 – 0.4.10 · Ask the form (§32)

- **Why.** The applicant asked to "try to submit" to learn what was missing.
  Real submission is out of the question, so the extension blocks `fetch`,
  `XMLHttpRequest`, `sendBeacon`, `form.submit` and the submit event, presses
  Submit, and reads every `aria-invalid` field and its message.
- **What it gives.** A diff of the form's complaints against the plan:
  `FILL` (filler defect), `review` (expected), `not in plan` (extraction gap).
  This became the oracle for every later round. Rows are logged as plain
  lines (0.4.10) because pasted console tables lose their content.

### 0.4.11 · Fieldsets of radios were classified but not filled

Choice groups rendered as `<fieldset>` were recognised as one question and then
skipped by the writer. Now filled through the matching radio; the per-select
instance wait extended to 20 s for slow boards.

### 0.4.12 – 0.4.13 · The root cause of "it knows but doesn't select" (§35)

- **Symptom.** For days, on standard Greenhouse forms, the console showed the
  right answer while the dropdown stayed empty, with an orange "not a
  react-select instance" note. The applicant's words: "it knows what the right
  answer is but does not select it, and therefore I think the extension isn't
  working."
- **Why it hid.** Every verification had been a page-world script injected
  through the browser tools — and those passed. The installed extension's
  content script runs in Chrome's **isolated world**, which cannot see
  page-attached properties such as `__reactFiber$…`. The driver had never
  worked inside the extension.
- **Fix.** The fill runs in the page's **MAIN world** via
  `chrome.scripting.executeScript`, dispatched from the service worker, with the
  isolated-world path kept only as a fallback. 0.4.12 also lets readback accept
  the widget's held value when the DOM lags, and stops a single note from
  aborting the run.
- **Lesson, now a rule.** Sign-off only from the installed extension on a real
  page with the console read back. Injection is for probing widgets.

### 0.4.14 – 0.4.15 · Readback and location on the standard renderer

Phone-country selects display "+1" for "United States (+1)": a display that is
part of the chosen option's text counts as shown. Location was never located on
the standard renderer because its input is `candidate-location`; the form-check
diff now maps rendered ids back to plan keys so its lines name the right field.

### 0.4.16 · Never write into a form React has not taken over (§37)

- **Symptom.** Schonfeld, tab occluded: 9 fields green, then a minute later no
  green at all and 12 of 13 selects with instances.
- **Diagnosis.** Greenhouse hydrates lazily and not while hidden. The fill had
  landed on the server-rendered DOM and hydration's re-render replaced it.
- **Fix.** Before writing anything: if hidden, wait for `visibilitychange`
  (not a timer); then wait for the last select to be React-owned. The console
  says "this tab is in the background — the fill starts when you switch to it".

### 0.4.17 · EU boards

`job-boards.eu.greenhouse.io` matched (Gensyn, Axiomatic).

### 0.4.18 – 0.4.19 · Round-5 fixes (§38)

- **Pacific Fusion.** A school lookup returned nothing for the typed term; the
  driver fell back to the default A–Z page and then, correctly, refused to pick
  from it. Now it retries the term and never uses the default page. Geocoder
  suggestions that repeat the same text are treated as one so uniqueness holds.
- **Lightmatter.** Loaded hidden, flickered visible, covered again: the 20 s
  hydration budget was spent in the dark. The budget now counts only visible
  time.

### Backend changes the surveys forced

Each found by a `form wants:` line on an unseen board, fixed in the backend,
and shipped as its own PR there:

| found on | defect | fix |
|---|---|---|
| Duolingo | "If so, are you eligible for OPT?" left blank for a US citizen; the form offered NA | inapplicable follow-ups select the form's N/A option (§25) |
| Duolingo | "Yes" written for work authorisation where the options were different words | `_within_options` guard: an answer outside the option set is never written |
| Duolingo | essential-functions question answered "No" | alias precedence: essential functions before accommodation |
| many | screening questions a person can answer from the profile stayed amber | a bounded Jev decision over the form's own options, ≥ 0.85, with derived notes (US citizen ⇒ visa programs N/A) |
| round 2 | required Country select, education start dates unfilled | country field, start month/year from the stored start date (§34) |
| round 2 | "How did you hear about us?" stored as Careers Website, option said "Company website" | own-site synonyms |
| rounds 3–5 | custom State / City / Address / "GPA (Undergraduate)" / "preferred first name" wording | aliases, derived from the stored location |
| round 5 | Xaira: required "If you answered No… will you require sponsorship?" with only Yes/No, left blank as "answered by a sibling"; Compeer: required "If yes, please explain" | a required inapplicable follow-up keeps a truthful answer of its own or goes to review, never blank |
| scale run | plans took 10–20 s | 4 s Jev budget, circuit breaker, `elapsed_ms` on every response, 600/hour plan limit |

---

## 4. The survey

Boards are held out: a frozen pool of live SWE-intern postings, a ledger of
boards already used, a fresh draw every round, never the same board twice.
"Filled" is the extension's own count of green fields; "could not enter" is the
count of fields where the plan had a value the widget would not take — the only
number that measures the extension rather than the profile.

| round | boards (live) | filled | could not enter | boards affected |
|---|---|---|---|---|
| 1 | 2 | 46 | 0 | — |
| 2 | 12 | 182 | 1 | clockworksystems |
| 3 | 9 | 149 | 0 | — |
| 4 | 17 | 252 | 1 | pacificfusion |
| 5 | 23 | 355 | 19 | lightmatter |
| 6 | 6 | 91 | 0 | — |
| **all** | **69** | **1075** | **21** | |

Postings that closed between the freeze and the run are excluded
(5 so far). The per-board log with what each form still wanted is
`survey_results.jsonl` in the working notes; the aggregate lives in
DECISIONS §36 and §38.

---

## 5. How the work was run

Two agents worked at once, and the split is the reason the loop closed fast:

- **Claude Code in the terminal** owned the code: backend, extension, tests,
  commits, one PR per iteration, one DECISIONS entry per iteration.
- **Claude in Chrome** owned reality: it drove the *installed* extension on
  real postings in the applicant's own browser — navigating, waiting for the
  form's own validation, reading the console lines and the page back. The
  applicant's rule: "when you run it I don't know if I can trust you running
  it versus running it in the browser — it's like testing vs real life."

The loop, per batch of two postings:

1. Draw unseen boards from the ledger. Never re-test on the training set.
2. Open each with the window on screen; wait for `aria-invalid` to appear
   (the dry-run submit has run) or 30 s.
3. Read `applied:` and every `form wants:` line. Log filled / could-not-enter /
   what remains per board.
4. Any `plan said FILL` or orange note is a defect. Diagnose it on that page
   (probe the widget with an injected script, inspect the board's public
   schema), fix it, bump the version, ask the applicant to reload the
   extension, and go on to *new* boards.
5. In parallel with the browser work, the terminal agent runs the tests,
   commits, opens the PR and writes the decision record — independent tool
   calls are issued together, so a page loads while a test suite runs.

Standing rules the applicant set, all of which changed the design:

- **Measure, never assume.** Every claim carries a sample size.
- **Select exactly what the menu provides.** No first-suggestion fallback, no
  fuzzy pick; an answer that matches no option is not written.
- **Speed matters.** A fill slower than typing is worthless; timing is logged.
- **Generality.** Fixes are for all Greenhouse boards, not the one in front of
  us; training boards and testing boards are kept apart.
- **A CR per iteration.** Every change is a commit, a PR and a decision
  record, so the history explains itself.
- **Never submit.** The dry-run submit exists so that nothing else has to.

---

## 6. Notes for whoever edits this next

- **Content scripts are classic scripts.** An `export` in one is a syntax
  error at load and the script silently never runs, which looks exactly like
  the extension not being installed. Only `background.js` is a module.
- **The fill runs in the MAIN world.** `fill.js` is injected by the service
  worker with `chrome.scripting.executeScript({world: "MAIN"})`. Code that
  needs `__reactFiber$` or `__reactProps$` must live there; the content script
  cannot see them.
- **Network calls go in the service worker.** A fetch from a content script
  carries the page's origin and is subject to CORS; the worker holds host
  permission and is exempt.
- **Radio inputs sharing a `name` are one question.** Real Ashby forms have no
  legend, so reading them separately turns one protected-characteristic
  question into eight fields that no safety rule recognises.
- **Dropdowns cannot be opened synthetically.** Greenhouse controls
  `menuIsOpen` from its wrapper. Selection goes through the instance's
  `selectOption`; async ones through their `loadOptions`, with the typed term
  retried and the default page never used.
- **Greenhouse does not hydrate hidden tabs**, and its hydration re-render
  discards anything written before it. Wait for visibility, then for the last
  select to be React-owned, then write.
- **Ashby renders its demographics section late.** The content script samples
  the control count until it stops changing. Do not force it by scrolling to
  the bottom — that froze the renderer on a live posting.
- **Greenhouse's phone widget strips the dashes** you type; "301-906-3249"
  reads back as "3019063249". Same number, not a failed fill.
- **Passwords are never read.** Not extracted, not sent, not filled.

## Permissions, exactly

`storage` (profile and résumé, local), `scripting` (the MAIN-world fill),
`activeTab` (click-to-run on employer domains), and host permissions for the
Greenhouse and Ashby job-board hosts and Greenhouse's public board API. No
`<all_urls>`, no background access to any other site.
