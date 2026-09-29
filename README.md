# FirstPlay Autofill — Chrome extension

Fills job applications from answers you have already given, on the real form,
in about two seconds. You review what it wrote and you press Submit. **It never
submits for you.**

Measured so far on **101 live Greenhouse postings** on boards never opened
before (a fresh draw every round): **1625 fields filled**, **21 cases** where
it knew the answer but could not enter it — all 21 on three boards whose
defects are fixed and recorded below. What a form still asks for after a fill
is essays, consent boxes and one-off questions ("which office?", "can you lift
50 lb?") that no profile answers.

The companion backend, which makes every decision, is
[firstplay-backend](https://github.com/victorzhu443/firstplay-backend). Its
`docs/DECISIONS.md` records each decision with the measurement behind it;
this README cites those sections as §N. Section 3 below is the complete
chronological log — what was tried, what broke, how it was found, what
changed, how it was verified — and section 4 is how the work was run.

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

## 3. The complete iteration log

Everything below is reconstructed from the primary records: the backend's
`docs/DECISIONS.md` (§0–§38), both repositories' git histories, and the
survey ledger. Every number is quoted from one of those; where a record is
missing, it says so. Backend pull requests are cited as PR #n on
firstplay-backend; extension pull requests as ext PR #n; extension versions as
0.4.x.

The single rule that governed all of it, set before any code: **never
conclude from assumption — measure against real postings, record the number,
and say how many postings it came from.** It is recorded at the top of
DECISIONS with the assumptions it caught: "the long tail is full of *do you
have experience with X*" (3 fields across 42 applications); "label-wording
regexes catch EEOC questions" (decided 0 of 2,429 fields); "the risky path is
the model path" (100% precision on model decisions; all 7 measured errors came
from memory lookups); "no form offers a no-preference option" (stated from 57
postings; widening to 156 found the one that did).

### Part A — Before any code: two spikes and a design (2026-09-23 → 09-27)

**1. The API spike (2026-09-23).**
*Why.* Form extraction was assumed to be the project's biggest risk.
*What we did.* Read live Greenhouse and Ashby forms by hand.
*What we found.* Greenhouse publishes the whole application form,
unauthenticated, through its public board API (`?questions=true`). Ashby has
no form-schema API; its posting API returns metadata only, so Ashby needs a
DOM extractor. Both name core fields stably (`first_name`/`email`;
`_systemfield_name`). Across 40 live postings the field-type vocabulary was
small and closed.
*What it changed.* Extraction became the cheap part for these two vendors;
the design effort moved to deciding answers. Workday was recorded as the
genuinely hard case and left untested.

**2. The measurement that sized the problem.**
*What we did.* Pulled 148 live Greenhouse postings, 2,685 fields, and
classified every field by vendor structure.
*What we found (from the design plan that preceded the code).* 56.5% of
fields were core, document, legal, consent or unknown and needed no model at
all; 37.6% were screening questions; 5.9% narrative. The 1,010 screening
fields used only 117 distinct labels; the top 12 covered 43.9%; the long tail
was 6.4% of volume. Those labels collapsed into about nine themes, and two of
them — "have you worked here before" and per-country work authorisation —
were *computable* from stored facts, roughly a quarter of screening volume.
*What it changed.* The architecture: a recogniser in front of a fact store,
not an agent that reasons about applications (§0).

**3. The design, written before the code.**
*Why.* An earlier attempt to start writing files straight after a design
conversation was stopped: "think about what to build first and then build it
dont spur of the moment decide to build" and "think think think ask questions
if yuo dont know find the asnwer." The plan was researched first: the actual
Jev API reference, the actual public repos, the actual live pages.
*What was decided.*
- **Five gates, cheapest first:** exact ATS key → normalised label alias →
  theme classification (cache, else one batched Jev Choice) → option
  matching → narrative. Two themes resolve in code, not by model (§9).
- **Themes, not direct fact binding** (§8): measured later, 123 distinct
  screening phrasings collapse to 21 themes; `work_authorization` alone
  covers 18 wordings at confidence 1.00. A theme is an atomic question with a
  stable option set, so it is cacheable; fact binding would need a different
  option set per applicant.
- **The Jev boundary:** one module over `httpx` against OpenRouter's
  decisions endpoint, model `typesafe/jev-1.13`, one batched call per form
  (state is sent once, extra questions are nearly free). Not the official
  SDK: it requires Python 3.10 and the project pins `py39` deliberately so
  ruff does not rewrite `Optional[X]` into `X | None` and break Pydantic at
  runtime. Client-side limits enforced: Choice ≤ 255 options.
- **Thresholds by cost asymmetry, not one global 0.5:** ≥ 0.85 to fill a
  theme or an option match; 0.5–0.85 pre-fill and flag; below 0.5 ask.
- **Standing decisions:** AI-policy attestations are HUMAN (the one field
  where an autofill tool would attest to its own involvement); undocumented
  multi-selects HUMAN; never auto-submit.

**4. The product-intent correction (§5).**
*What went wrong.* The first classification made every legally sensitive
field never-fillable.
*How we found it.* On a real Figma application the difference was 19/19
fields filled versus 7/19. An early version left 212 fields for manual entry
on every application.
*What we changed.* Two acts had been conflated: a model *inferring* veteran
status (never acceptable) and the applicant *stating* it once and the tool
replaying it byte-for-byte (the product). `ALLOWED_FILL_SOURCES` now gates
every field by where a value may come from; protected characteristics are
MEMORY-only. The one exception is consent: an arbitration agreement or GDPR
tick *creates* an obligation at the click rather than reporting a fact, so
it stays manual (§14).

### Part B — The backend engine (2026-09-27, PRs #9–#13)

**5. PR #9 — extraction, memory, classification, binding** (`dd16aec`).
The engine as designed, with the decisions that measurement forced along
the way:
- *Classification reads vendor structure, never label wording* (§7). A
  label regex decided 0 of 2,429 fields, and on a real Ashby form would have
  missed race and gender entirely because radio inputs are labelled with
  the *answer* ("Hispanic or Latino"). Removing it closed a hole where 11
  protected fields were model-fillable. Standing rule: a heuristic may only
  ever make a field *less* auto-fillable.
- *Arithmetic and calendars in code* (§9): GPA ranges, graduation terms,
  phone formats, country aliases, "worked here before". Moving three shapes
  off the model path shrank the model-decided share from 7.2% to 4.2% with
  no loss of coverage.
- *No résumé-screening gate* (§4). Rejected on measurement: it would answer
  3 fields across 42 applications (0.07 per application) at the cost of
  sending the full work history to OpenRouter on every run and letting a
  model assert qualification claims.
- *Coverage excludes essays, attestations and unreadable questions* (§1):
  909 fields → 753 fillable.
- *Precision target 99%, not 95%* (§2): 95% is one false statement per
  20-field application under the applicant's name.
- *The real target is review fields per application* (§3): median ≤ 2 at
  100% precision; at the time, median 3 (mean 2.9, 21/42 applications at
  ≤ 2).
- *Attestations stay human; stable facts do not* (§6): treating "are you a
  government official?" as permanently manual cost ~70 fields.
- *Standing skips are answers, not gaps* (§11); a skipped **required** field
  still surfaces for review, because a silent blank blocks submission.
- *Never infer a country from an institution name* (§15) — after a wrong
  Masters/PhD answer at 0.92 confidence showed what generic-onto-specific
  does.

**6. PR #10 — the Jev decision client and the three model gates**
(`d68865b`). Theme classification, option translation, and the batched
call; errors classified (401/422/429/529); the suite stays credential-free
by mocking at the client boundary.

**7. PR #11 — `POST /api/autofill/plan`** (`07c85a8`). The FillPlan is a
proposal; every field is filled, satisfied, or flagged, and the applicant
submits (§10).

**8. PR #12 — measurement tooling** (`7189891`): the frozen corpus, the
labeller, the scorer, `try_posting`. Two decisions came out of using it:
- *Labels key on the resolution, not the instance* (§12). Per-posting keying
  made the same person confirm his own first name four times in a 40-field
  session; re-keying turned 40 labels into 375 labelled fields. The labeller
  confirms `wrong` and `should-have-asked` but not `correct`; one session
  produced 7 mis-keyed "wrong"s out of 428 — a 1.6% labelling error rate,
  the same order as the precision being measured.
- *Caches invalidate when the taxonomy changes* (§13). Adding a theme did
  nothing for labels already cached; 158 stale entries were masking a known
  bug, invisibly, because the cache reported a hit.

**9. PR #13 — the decision log** (`9031ab7`). State at that point, measured
on 42 unique live postings, 909 fields: coverage 87.2% (650/745 fillable),
precision 100% over 428 labelled fields including 12/12 model decisions,
median 2 review fields per application (7/42 need none, 24/42 need ≤ 2),
model-decided share 4.1%, about $0.006 per full run, 553 offline tests.

### Part C — Extension iterations 1–3 and the first real fills (2026-09-27)

The extension's first three iterations predate its git history (its first
commit is 0.4.3); what they did is recorded in DECISIONS §16–§25 and the
README checklist that shipped with them.

**10. Iteration 1 — read and plan.** Detect Greenhouse and Ashby postings,
read the controls (collapsing radios sharing a `name` into one question),
fetch Greenhouse's authoritative schema, request a plan and log it with cost
and model-call count. Two facts fixed here: content scripts are classic
scripts (an `export` silently disables one), and network calls belong in the
service worker (a content-script fetch carries the page's origin).

**11. Iteration 2 — write.** Text through React's native value setter;
every touched field outlined (green filled, amber needs you, dashed blue
attach). Three measurements from the first Figma and Notion runs:
- *The API's compliance block is not authoritative for what the page
  renders* (§17): the API listed `race` for a posting whose form had only
  `hispanic_ethnicity`. Because `locate()` requires an exact label match,
  "Asian" did not go into a Yes/No question — but the plan had *reported* it
  filled. Plan entries are now reconciled against the live DOM and an entry
  with no element is "not on this page".
- *File uploads are attachments, not fills* (§18): browsers forbid setting a
  file input from a script; 53 such fields across the 42-posting corpus.
- *Ashby radio-group names carry a per-page-load UUID; only the suffix is
  stable* (§19): the same Notion posting gave
  `d5e6e981-…__systemfield_eeoc_gender` on one load and `9fbac581-…` on the
  next. Matching on the suffix made all three EEOC radios fill and read back.

**12. Iteration 3 — dropdowns (§16).**
*What went wrong.* Greenhouse dropdowns would not take a value.
*How we found the driver.* Measured on a live form, in order: `el.value = x`
(React re-renders over it); synthetic `mousedown`/`keydown` (`aria-expanded`
stays false); the control's React `onMouseDown` via `__reactProps` (focuses,
does not open); `instance.openMenu`/`setState({menuIsOpen:true})` (overridden
next render); a **trusted** click opens it — which proves the widget works
and that a content script cannot produce the event; `instance.selectOption`
with the menu closed **selects, and the displayed value confirms it**.
*Why.* `menuIsOpen` is a controlled prop; Greenhouse's wrapper re-asserts
it every render. Selection does not need the menu.
*What we changed.* Find the react-select instance on the fiber tree, call its
own `selectOption`, read back the displayed value before reporting filled.

**13. Employer-hosted postings come in three shapes (§20).**
*Measured.* Of the 57 live SWE-intern postings in the frozen corpus, 26 apply
on `*.greenhouse.io` and 31 on the employer's own domain, all with
`?gh_jid=`. Three opened live rendered three ways: Duolingo serves the form
on its own domain (14/24 controls by id); Lyft's careerpuck page opens a
`job-boards.greenhouse.io` iframe only after Apply (45 controls, 21/22 by
id); Samsara's embed never renders (2/31, cause unknown).
*What we changed.* `?gh_jid=` recognised on any host; the board inferred from
the embed script or the domain and **verified** against the API (board
tokens are global, so a wrong guess could return a stranger's form);
`all_frames: true` so the frame path is automatic; click-to-run via
`activeTab` for the Duolingo shape instead of `<all_urls>`.

**14. The first real click-to-run, and the rule it produced (§21).**
*What went wrong.* On Duolingo, name, email, phone and preferred name filled
— then nothing. Victor found it before I did.
*How we found it.* The plan's id for "expected graduation timeline" sat on a
`<div role="group">`; the input setter threw `Illegal invocation` and the
exception unwound the whole loop. I had checked that ids matched the API and
had not run a fill.
*What we changed.* Every control is filled inside its own `try`. Dropdowns
are dispatched by what is on the page, not by what the API calls the field:
react-select (fiber → `selectOption`), Duolingo's button-and-listbox (click,
poll for the list, click the option — and never re-click a selected option,
which **deselects** it), native `<select>`.
*How we verified.* The backend's real plan for Duolingo 8805925002 applied in
the page: 13/13 FILL fields read back correct, 1 attach, 6 review, 0 failed.
*Rule adopted.* A change to the fill layer is not done until a real plan has
been applied to a real page and read back; structural checks were green
here and proved nothing. Victor's words: "you must always test and then test
and then test."

**15. Dropdowns across the sites people actually apply on (§22).**
*Why.* Victor: don't stop at Duolingo — find out how dropdowns work on the
sites people will always apply through.
*Measured live.* Stripe, Databricks, Coinbase, Lyft: react-select in an
embed frame or a new tab. Duolingo: listbox. Samsara: never renders. Ashby
(Notion ×2, Perplexity; 45 field entries): **no dropdowns at all** — radios,
checkboxes, and one Location autocomplete fed by a remote geocoder ~2 s
after typing.
*What the Ashby measurement found beyond dropdowns.* Every question sits in
a `fieldEntry` container whose first label is the question text — the
extractor had never looked there, so radio groups shipped with blank labels
and the classifier correctly refused them. The adapter was regrouping
already-grouped radios and blanking the label. Checkbox *options* ("New
York, NY", "Billboard/Outdoor Ads", "Infra") were being read as questions
and matched to the applicant's location, heard-about answer and track —
three wrong FILLs on one form. Two aliases missing ("Phone", "Github Link").
*How we verified.* Notion's Software Engineer Intern form, real plan: before,
15 FILL of which 5 wrong; after, 16 FILL, 0 failed, 0 wrong, 8 review.
*A Greenhouse regression pass on Lyft found two backend precision defects
the 42-posting corpus never exercised:* "Can you perform these essential
functions… with reasonable accommodation?" matched the accommodation alias
first and rendered the stored "no accommodation needs" as **"No"** — the
inverted answer at confidence 1.0 (alias order fixed, test pinned); and
"Work Authorization" with three sentence-long options got a computed "Yes"
the page could not select — `_within_options` now downgrades any value
outside the form's options to a mismatch that reaches the model gate, which
translated it to the full sentence at 0.99. After both: 553 tests, corpus
unchanged at 89.1% / 100% — these defects were invisible to it.
*Measurement note.* The debugger timed out at 45 s on background tabs while
the fill kept running; Chrome throttles background timers to about one per
second. The timeouts said nothing about the extension.

**16. Education and self-identification are API blocks, not questions
(§23).**
*Why.* Victor: "it works up to the education part"; and build it for all
postings, with Workday next.
*Measured.* `education_required` on 36/57 corpus postings;
`demographic_questions` on 12/57; `compliance` on 27/57 — none under
`questions`, which is why the plan never mentioned them. Degrees (10) and
disciplines (73) come from the board's public endpoints; schools are a
typeahead.
*What we changed.* The service worker fetches the vocabularies and the
adapter synthesises `educations[0].*` as CORE fields; the profile's existing
`degree`, `graduation_date`, `university` derive `degree_type` in
Greenhouse's own words. On the standard renderer the controls are async
react-selects whose options stay empty until loaded — calling the
`loadOptions` prop found up the fiber returns options immediately and
`selectOption` renders them. Self-identification keys are LEGAL by block
membership, replayed exact-or-nothing plus one synonym pair (Male↔Man).
*How we verified.* Scale AI 4730834005: 4/4 rendered education fields filled
and read back (Cornell University, Bachelor's Degree, Computer Science,
2028).
*Duolingo's comboboxes, resolved.* Victor: "it knows what the right answer
is but does not select it … i think the extension isn't working but it
is." Two defects: each combobox renders **two** search inputs and every
scripted attempt had targeted the decoy (`tabindex="-1"`) — a trusted click
showed `document.activeElement` was the second; and nothing opened when the
**window was not focused**, which is the state right after the popup is
clicked — dispatching `focusin` by hand opens it. Verified by hidden ids:
School 11784602002, Degree 11786718002, Discipline Computer Science, May
2028, gender Man, disability No.
*Two rules from this iteration.* A known answer that cannot be written must
be visible on the page (orange note with the value and the reason; the popup
counts them) — the plan's table and the page must never disagree silently
again. And, in Victor's words, "when you fill something out you must select
the exact thing that the select menu provides": one matcher for every widget
— exact text, else a prefix only when exactly one option has it, else
nothing. The autocomplete's old first-suggestion fallback had picked "Ithaca,
New York, United States" for "Ithaca, NY" by luck of ordering.

**17. Location is on every posting; the résumé is stored and attached (§24).**
*Why.* Victor: "now also try to do location which you have failed to do";
and "ask the user for their resume which they will provide and upload and
that will be stored in the extension so that it can be autofilled in
applications."
*Measured.* `location_questions` is present and required on 57/57 corpus
postings — another block outside `questions`; the page fills the hidden
coordinates itself after a pick (Duolingo wrote `-76.5018807 / 42.4439614`).
Geocoders repeat entries: Scale AI offered the same "Ithaca, New York,
United States" twice among six, and the exact-or-unique rule first refused
it as ambiguous — uniqueness is now judged on distinct texts.
*Résumé.* A script cannot give a file input a path, but it can build a
`File` and assign a `DataTransfer`; both renderers showed the filename and
fired their own presigned S3 upload. Stored once from the popup
(`chrome.storage.local`, capped at 6 MB), never sent to the backend. Victor
on the first cut: "i dont think its neccessary to click save to save it
should automatically save" — it saves on pick.
*What broke in the first real run after 0.4.0.* 21 fields filled; Location
failed with "offered: Cornell University | Bachelor's Degree | Computer
Science" — the other comboboxes' lists. The driver had a last-resort "any
open listbox on the page" fallback that fired before the geocoder answered.
Removed: a field reads only the listbox its own input (or its decoy twin)
points at, waits up to 8 s, and for a hidden-backed field counts a pick only
when the hidden value is set.

**18. "An agent that can think" — N/A follow-ups and the profile gate (§25).**
*Why.* Victor, on "If so, are you eligible or currently in a period of OPT?":
"it's obvious if I'm a US citizen that I would not need to care about
eligibility and the options allow NA … some agent that can think should be
allowed to exist." Then a screenshot: that field **YES, in green**, its
follow-up amber.
*Three defects, measured.* (1) The filler wrote a *sibling* entry: the plan
had marked the question "not applicable" but the entry still carried "Yes"
from the work-authorisation theme, and `applyPlan` skipped only `skipped`
entries — a precision failure on a live form (extension 0.4.3, its first
commit). (2) Inapplicable was treated as blank even when the form is a
required select offering NA; corpus: 19 conditional fields, 5 with an
N/A-type option, 3 both, all required — the N/A option is now selected
deterministically. (3) "After the OPT…" has no "if so", no theme, no stored
answer — only someone who knows the applicant is a US citizen can answer it.
Built as Jev's shape: a bounded choice over the form's own options, state =
non-protected profile plus answers already settled on this form, `unsure`
always available, accepted at ≥ 0.85 as MODEL_DECISION, run last, never for
LEGAL, CONSENT or free text. A derived note ("US citizen: F-1/CPT/OPT/…
do not apply") lifted the answer from 0.81–0.83 to 0.89.
*How we verified.* Duolingo: both OPT questions FILL "NA". Corpus: 13 fields
at ≥ 0.85, one call per form, $0.0013 total, each checked against its options
("Are you located in Qatar?" → No; Lyft's commutable-proximity → "I am
willing to relocate…"); coverage 89.1% → 90.4%; precision on the labelled 381
unchanged at 100%.

### Part D — Scale (2026-09-27, PR #14)

**19. Where internships actually are (§26).**
*Why.* Victor: run this across thousands of internships, provide the results
to score, then expand to Workday and company portals — and "I don't know if
I can trust you running it versus running it in the browser — it's like
testing vs real life."
*Measured.* SimplifyJobs' Summer-2026 list: 16,933 entries, 4,516 active,
3,206 engineering-ish. Workday 1,691 active (37%); company portals 973;
Greenhouse 666 (15%); Oracle/Taleo 341; Ashby 287; iCIMS 190; Lever 107;
SmartRecruiters 98. Greenhouse + Ashby are 22% of the market; Workday alone
is larger than both, so it is next.
*Two kinds of evidence, kept apart.* *Deciding* can run headless: from 205
board tokens, 190 answered, holding **1,269 intern postings** that reduce to
**578 unique forms**, frozen with each board's education vocabularies.
Deterministic pass: 6,658 fields filled, median 12 per form, 85 distinct
(question, answer) pairs — the unit Victor scores. *Filling* cannot: every
filler defect found that day lived on the page, so that tier is the
installed extension in Victor's Chrome, small by construction.

**20. The scale run (§27).**
*Measured* with `python -m app.autofill.scale`: 578 forms deterministic /
576 with model gates; 6,658 → **9,386** fields filled; median 12 → 17 per
form; 5,957 → 3,121 left for review; 85 → **983** distinct decisions; 825
model-decided fills (254 distinct); 802 Jev calls, 2,662 questions,
**$0.10**. The 983 decisions went onto a scorecard for Victor, weighted by
the forms each covers.
*Two defects seen before scoring, fixed.* "Select your anticipated master's
degree graduation date" → 05/2028 at 0.99 for an applicant pursuing a
bachelor's — the gate's state now carries a derived degree-level note.
Rothesay Graduates' 552-option university list failed the whole form because
a Jev Choice takes at most 255 — both gates skip fields with more than 254
options.
*What the 3,121 reviews are.* 1,695 bespoke ("nothing stored answers this");
284 human-only by class; 291 stored answers matching no option
unambiguously; 89 onboarding answers not given; 198 self-identification
questions the profile does not hold.

### Part E — Speed, and the first survey tools (2026-09-28, PRs #15–#16, ext PRs #1–#3)

**21. Speed is a requirement (§28; PR #15; 0.4.4, ext PR #1).**
*Why.* Victor: "the time it takes to choose items is slow … if it is slower
than by hand then what is the point."
*Measured before changing anything.* Fetching the posting and vocabularies:
0.4 s. Building the plan: **10–20 s with zero model calls counted.** The
server log had it: every Jev call in that process was hitting the 10 s read
timeout and the endpoint fell back after each, up to three times per plan. A
fresh process reached Jev in 0.24–0.39 s in the same minute; after a restart
the same plans took 1.3 s, 0.9 s, 4.6 s cold, 0.01 s repeat. The process was
sick; the design let a sick model cost 20 s.
*What we changed.* A 4 s per-call budget (was 10); a circuit breaker per
plan, with `model_skipped` and `elapsed_ms` on every response so a slow fill
is blamed correctly; the plan request fires the moment the posting is
recognised, while the page settles; a six-hour session cache keyed on
posting + profile (a re-run costs 0.01 s); every fixed nap became a 40 ms
poll; every run prints `page settled · plan ready · filled · total`.

**22. Fill in tiers (§29; 0.4.5).**
*Why.* Victor: "the education is still quite slow — I'm expecting 10 ms for
each option"; "try to do things in parallel."
*Measured.* The filler awaited each widget in turn: education on the
standard renderer paid three sequential lookups of 0.3–0.8 s each.
*What we changed.* Four tiers: instant (text, radios, résumé, synchronous);
react-select (every option lookup fires concurrently, picks are synchronous
`selectOption` with a 40 ms readback poll); autocomplete (all searches
started first, then picked); listbox (one after another, since opening one
may close another). Widgets that need focus are never driven concurrently —
only their lookups are.
*How we verified.* Duolingo: after the start pass all four lists (school,
degree, discipline, location) were populated at once.

**23. Coinbase: a hydration race and an unbounded search (§30; 0.4.6, ext
PR #2).**
*Why.* Victor: "now I want this to be reproducible across many many
different Greenhouse applications … for example Coinbase doesn't work."
*What went wrong.* Plan in 0.38 s with 24 fills; text filled; **every
dropdown carried an orange note offering "Afghanistan+93 | Åland
Islands+358 | …"** — the phone widget's country list.
*How we found it.* Two defects behind one symptom. Since the plan now left
early it arrived before React had hydrated the form; with no fiber yet, the
selects fell through to the autocomplete path. That path found a field's
list by walking up to the nearest ancestor with any `aria-controls` — nine
levels, to the `<form>` with 55 inputs, whose first pointer was the phone
picker's.
*What we changed.* Recognise react-select from its markup and wait for an
instance before the react-select tier; bound the list search to three
levels and never a container holding other fields' inputs.
*How we verified.* All three education lookups prefetched in parallel in
**67 ms**; each pick selected the one option its loader returned.

**24. Structural survey across ten boards (§31; 0.4.7).**
*Why.* Victor: "don't fit this for only Duolingo — the purpose is this
extension works across all Greenhouse applications."
*Measured.* Gallup, ATOMS, Baidu, Appian, Faraday Future, Brevium,
Businessolver, SingleStore, Coinbase: every planned field a page renders is
located, 96% by id and the rest by label. Misses were education fields a
board does not render (correct "not on page") and `race` on 7 of 9 boards —
the page renders the two-question EEO block, and `race` is mounted only
after `hispanic_ethnicity` is answered (verified on Gallup: absent before,
present after).
*What we changed.* The stored race derives the Hispanic answer, fills it,
waits for `race`, fills that. Replay of the applicant's own answer; no
model sees it.
*Also seen.* Gallup at first paint: 0 of 26 selects hydrated — §30's race,
caught on a second board.

**25. The form is the oracle (§32; 0.4.8 and 0.4.10, ext PR #3).**
*Why.* Victor: "we must always check … run it across different Greenhouse
applications, then try to submit, and if it doesn't submit figure out what
fields have been filled, what have not, whether the filled ones are correct,
and whether the unfilled ones are 'filled' with the right answer but not
selected."
*Measured on Gallup.* With every way of leaving the page blocked, clicking
"Submit application" made Greenhouse mark **71 elements `aria-invalid`**
with its own messages, fired no submit event and attempted no network write.
Greenhouse validates client-side before it posts.
*What we changed.* After every fill: block `fetch`, `XMLHttpRequest`,
`sendBeacon`, `HTMLFormElement.submit` and the `submit` event; press Submit;
read every invalid field; print the diff against the plan — `FILL` (filler
defect), `review` (expected), `not in plan` (extraction gap, e.g. Gallup's
Address Line 1). The popup says "form still wants N". Rows are plain lines
(0.4.10) because pasted console tables lose their content.
*The line.* Victor set it on day one: "don't actually apply and submit jobs
but practice and see." The dry run gives the information without crossing
it.

**26. The plan endpoint gets its own rate limit (§33; PR #16).**
*What went wrong.* During round 2 the extension logged `backend returned
429: Rate limit exceeded for LLM-backed endpoints: 30 requests per 60
minutes` — the plan endpoint shared the limit meant for the résumé
pipeline's four-call chains.
*What we changed.* `RATE_LIMIT_AUTOFILL`, default 600 per hour: enough for
an evening of applying and a survey run, small enough to stop a loop.

### Part F — The held-out rounds (2026-09-28, PRs #17–#19, ext PRs #4–#6)

Victor: "do this over and over again … the point is to not use the same
testing group."

**27. Round 2, first three boards (§34; 0.4.11; PR #17).**
*Method.* Round 1's boards became the training set; round 2 drew twelve never
opened, run by the installed extension (0.4.9) with the dry-run check.
*What the first three showed.* Mill: 6 filled, 0 failed, 1.8 s; the form
wanted **Country** — a required select no API block describes. Chicago
Trading Campus: 10 filled, **12 "not a react-select instance"**, 48 wanted
including school, degree, discipline, start month/year; "How did you hear"
is a fieldset of radios; education **start dates** were never planned. NISC:
6 filled, 6 "not a react-select instance", and "still wants 0" — a false
negative: in a hidden tab React never hydrated, so neither the selects nor
the validation existed.
*What we changed.* `country` synthesised for every standard form (from an
explicit country, else a US state in the stored location → United States);
`educations[0].start_date.month/year` synthesised and the profile gains
`education.start_date`; the filler waits for **each** select's instance up
to 20 s and treats a fieldset of radios as a choice group (0.4.11, two
commits: classified, then actually filled).

**28. The select driver never ran where it could work (§35; 0.4.12–0.4.13,
ext PR #4).**
*What went wrong.* Round 2, Clockwork: the extension's notes said "not a
react-select instance" on School, Degree, Discipline, End month; a probe run
in the page at the same moment showed all six selects owned by React. Both
were true.
*How we found it.* Chrome runs content scripts in an **isolated world**: the
DOM is shared, but properties page scripts attach to nodes — React's
`__reactFiber$…`, which the driver walks to reach `selectOption` — are not.
From inside the extension the react-select driver had **never** worked.
Coinbase's, Chicago Trading's, NISC's and Clockwork's "known but not
selected" dropdowns were all this one cause; the hydration explanations of
§30 and §34 were only part of the story.
*Why it hid for so long.* Every fill verification I ran was a page-world
injection through the browser tools, and it passed. The installed
extension's own runs were read only by their console counts, which said
"filled" for text and "known but could not be entered" for selects — and the
selects were blamed on hydration. Victor's rule — the installed extension,
on real pages, read back — is the one that caught it.
*What we changed.* The service worker injects `fill.js` with
`chrome.scripting.executeScript({world: "MAIN"})` and awaits `applyPlan`
there; the content script keeps extraction, the plan request and the report;
the isolated copy stays only as a fallback and says so. 0.4.12 also lets
readback accept the widget's held value when the DOM lags and stops one
orange note from aborting the run.
*What it did to the numbers.* Every standard-renderer dropdown result before
0.4.13 that came from the installed extension is void; the page-world
verifications (Figma, Scale AI, Coinbase, Gallup) stand, because that is the
world the filler now runs in.

**29. Round 2 complete (§36; 0.4.14–0.4.15, ext PR #5; backend `9cfb010`).**
*Measured, tab visible, 0.4.13 from Clockwork on.* Clockwork 15/1 (4.2 s);
Garda 9/0; Verkada 19/0 (1.7 s); TribalScale 12/0; Docugami 8/0 and wanted
nothing; Internship List 23/0; Vercel 19/0; Integra FEC 22/0; Apera 10/0.
Chicago Trading and NISC were pre-page-world and re-run in round 3.
*Found and fixed.* `location` never located on the standard renderer — its
control is `candidate-location`, and every board above wanted it (0.4.15,
with the form-check diff mapping rendered ids back to plan keys). Clockwork's
phone-country select shows "+1" for "United States +1" — a display that is
part of the chosen option's text counts as shown (0.4.14). The heard-about
multi-select: "Careers Website" now matches the one option naming the
employer's own site — 26 such fields in the large corpus, 25 required.
*What remained wanted.* Education start dates (a profile gap), essays,
attestations and consents (human by design), bespoke questions.

**30. Never write into a form React has not taken over (§37; 0.4.16–0.4.17).**
*What went wrong.* Round 3, Schonfeld, tab occluded: 9 fields green and one
select noted as having no instance; a minute later 12 of 13 selects had
instances and **no green outlines at all**.
*How we found it.* Greenhouse hydrates lazily and not while hidden; the fill
had landed on the server-rendered DOM and hydration's re-render replaced it.
The 20 s wait only delayed the same outcome.
*What we changed.* Before writing anything: if hidden, wait for
`visibilitychange` (not a timer); then wait for the last select to be
React-owned. The console says "this tab is in the background — the fill
starts when you switch to it." 0.4.17 added `job-boards.eu.greenhouse.io`
(Gensyn ran on it in round 5).
*Measurement note.* macOS reports a window covered by another window as
hidden, so "keep the tab active" is not enough; the Chrome window must be on
screen. The rounds ran under that constraint, with visibility reported on
every read.

**31. Rounds 3–5 (§38; 0.4.18–0.4.19, ext PR #6; PR #18).**
*Measured.* 38 boards (closed postings excluded): 583 fields filled green;
20 "known but could not be entered", on 2 boards; 36/38 boards with zero
entry failures.
*Pacific Fusion (1).* A school lookup returned nothing for the typed term;
the driver fell back to the default A–Z page and then, correctly, refused
to pick from it. 0.4.18: retry the term, never use the default page.
*Lightmatter (19).* Loaded hidden, flickered visible, covered again: the 20 s
hydration budget was spent while Greenhouse was not hydrating, the wait gave
up, and the fill landed on the server-rendered DOM — §37's failure through a
gap in §37's fix. 0.4.19: the budget counts only visible time; a hidden page
parks on `visibilitychange` and resumes with its budget intact.
*What the forms still wanted, by kind (top of the table).* Bespoke
per-company questions on 12 boards; essays on 9; attestations on 3; security
clearance on 2; then singletons — street address, salary, pronunciation, a
Duolingo account, a competing offer, an employment block, an office
multi-select, SAT/ACT. None is a widget failure.
*Alias gaps closed this round (backend `846393a`, `9023c80`, `1d97c83`).*
Custom State/Country/City/Address questions derive from the stored location;
"What is your preferred first name"; a State select whose label carries an
"if N/A select Other" clause; "GPA (Undergraduate)".
*Measurement hazards, recorded.* ZipRecruiter's page is slow and looked like
a failure until a second read; a JavaScript read that waits on a hidden tab
longer than the debugger's 45 s timeout freezes the reader, not the page.
Reads now wait at most 30 s and report `visibilityState` with every count.

**32. A required follow-up with no N/A option (PR #19; backend `0bd4e40`,
`6239a82`).**
*What went wrong.* Round 5, Xaira: "If you answered 'No' to the previous
question, will you require sponsorship?" is required with only Yes / No.
The plan hid it as "answered by a sibling", the fill left it blank, and the
dry-run submit refused. Compeer: a required "If yes, please explain" text
field, same treatment.
*How we found it.* The `form wants:` line said `plan said sibling` against a
field the form called required; the board's public schema confirmed
`required: true` and no N/A option.
*What we changed.* A required inapplicable follow-up keeps a confident
answer of its own when it has one (the sponsorship theme had already
answered "No" from the stored fact, truthfully) and otherwise goes to
review — never blank. Also the alias "State/Province/Region:"
(TransMarket). Two tests pin both cases.

**33. Rounds 6–7 — the hundredth board (2026-09-28).** Drawn from the 73
boards still unused in the pool, then a 12-board reserve when closed
postings thinned round 6. Rounds 6–7 together: 4 boards opened,
1 excluded (closed since the freeze, or redirected to an
employer-hosted form outside the auto-fill hosts), 3 live,
48 fields filled, **0** known-but-not-entered — the first
rounds with none at all, on boards none of the fixes had seen.
*What went wrong.* Nothing in the widget layer. The `form wants:` lines
found four gaps in the *answers*: DRW asks "Legal First Name" / "Legal Last
Name" as custom questions beside the standard ones; Visier's Canadian form
says "Province/State"; Xaira's required sponsorship conditional and
Compeer's required "if yes, explain" (entry 32) were re-verified fixed.
*How we found it.* The same readback as every round; each gap was checked
against the board's public schema before an alias was added.
*What we changed.* Three aliases with a resolution check (backend PR #19,
same branch as the conditional fix); backend restarted; Xaira re-run through
the installed extension: 19 filled where it had been 18, and the
conditional gone from the form's wants.
*Whole run.* 110 boards opened, 101 live, 1,625 fields filled, 21
known-but-not-entered in total — 1 Coinbase-era (0.4.6), 1 Pacific Fusion
(0.4.18), 19 Lightmatter (0.4.19) — and 0 across the 38 boards run after
0.4.19. 29 of the 101 forms wanted nothing more after the fill. The 184
remaining wants, classified by hand: 58 bespoke per-company questions, 26
essays, 15 consents, 14 office preferences, 14 availability/term questions,
13 profile or alias gaps (6 fixed in the run), 13 custom self-identification
wordings (never inferred, by rule), 12 source/referral variants, 10 academic
details not in the profile, 5 pay expectations, 4 clearances. The decision
record is backend DECISIONS §39; the next platform is Ashby, on the same
protocol.

**34. Widening the profile-answer gate (2026-09-28, backend PR #21).**
*Why.* The hundred-board run left 184 wants. Sorted by hand, about 50 were
bounded decisions from facts the applicant already holds — term
availability, class standing, clearance, career fairs, prior internships,
GPA scale — that the model gate never reached: it refused multi-selects,
its state carried neither today's date nor the term calendar, and four
facts were not in the profile at all.
*What went wrong when we tried.* Three things, each caught by running the
real model on the boards that had exposed the questions. A Noul asked
"would the applicant tick this option?" on a clearance list with a silent
profile said "Never held a clearance" at 0.90 — a guess, exactly on the
threshold. The term question sat at p=0.50 on "Spring 2027" because the
availability note said "any term acceptable" while the earliest start was
May 2027. And "Not Applicable" scored 0.15 as a proposition even when the
profile said the applicant holds no clearance, because a model does not read
"not applicable" as a thing one ticks.
*How we found it.* `try_posting` in-process against the frozen postings
with the real profile and the real Jev, printing per-option beliefs; then
the same with a temporary profile copy carrying the four new facts, so the
facts path was exercised without writing guesses into Victor's profile.
*What we changed.* Multi-selects with at most 12 options are asked as one
Noul per option (tick at ≥0.90, no at ≤0.10, anything between leaves the
whole field as a suggestion); batches are cut by question count, not
request count. The Noul wording makes silence a no ("the profile says
nothing that bears on it"). The state gains today's date, class standing
derived from the education dates, and an availability note with the months
each term starts. When every concrete option is a confident no and exactly
one option means none, that one is chosen by elimination. Four facts join
onboarding: security clearance, career fair, prior internships, GPA scale.
*How we verified it.* Eleven unit tests with a Noul-aware fake; then live:
General Matter's three-term question went from review to Summer 2027 at
0.89; Compeer's academic status to Junior at 1.00; QuEra's highest education
obtained to "Some College, No Degree" at 0.87; with the facts present,
BTI's clearance to No at 1.00, Perpay's career fair to No at 0.97, Klaviyo's
prior internships to 1 at 0.94, Radix's GPA range to 0.0–4.0 at 0.89, and
Rocket Lab's clearance list to Not Applicable at 0.93 by elimination.
Optiver's eleven offices stayed with the applicant (the profile is silent on
offices, and the model now says so), and Varda's "seeking a Spring
internship?" stayed at 0.56 for an applicant whose profile says any term
after May 2027 is fine — a genuinely open question. Ten fresh held-out
boards (round 8) produced ten model decisions, every one traceable to a
stored fact, and one policy catch: Maven Securities' UK-worded "support or
adjustments during the recruitment process" was classified as screening and
answered "No" by the gate; it is disability-adjacent and is now a protected
pattern, memory-only. The multi-select path still awaits its first pass
through the installed extension, which needs the Chrome window on screen.

### What the log says in one paragraph

Two classes of defect account for nearly everything that ever went wrong on
a page: the extension writing before the page was ready to be written to
(hydration, hidden tabs, a decoy input, an unfocused window), and the
extension verifying itself in a world different from the one it runs in
(page-world probes for an isolated-world script). Both were invisible to
structural checks and to headless plans, and both were found only by
running the installed extension on postings nobody had opened before and
letting the form itself say what was missing.

---

## 4. How the work was run

The applicant did not write the code or drive the browser. He set the rules,
supplied the profile and the résumé, reloaded the extension when asked,
kept the Chrome window where it had to be, and judged the results. Two
agents did the rest, at the same time.

### The two agents

- **Claude Code, in the terminal**, owned the code and the record: backend,
  extension, tests (565 offline, credential-free), one branch and pull
  request per iteration on GitHub, one DECISIONS entry per iteration written
  in the same turn as the change. Victor's instruction: "make sure to keep
  updating crs every time we make a change to firstplay" and "like for every
  iteration we made include new cr."
- **Claude in Chrome**, in the applicant's own browser, owned reality: it
  navigated the *installed* extension to real postings, waited for the
  form's own validation, and read the console and the page back. Victor's
  reason: "I don't know if I can trust you running it versus running it in
  the browser — it's like testing vs real life." He was right in a way
  neither of us could see at the time (§35).

### Independent work issued together

Tool calls with no dependency on each other were issued in the same step,
so the wall clock overlapped instead of adding up:

- A page navigates and fills while the backend test suite runs.
- The backend restarts with a fix while the browser reads the previous
  board.
- A board's public schema is fetched from the API to explain a `form
  wants:` line while the next posting loads.
- The survey ledger is appended and the decision record written while the
  next batch of two pages runs.
- When the browser tab was hidden and could not fill, the terminal side kept
  going: the extension's GitHub repository was created and six stacked
  iteration PRs opened during one such pause.

Batches were held to two pages because the browser tool's 45 s limit is per
call and a slow board eats most of it.

### The held-out ledger

- A frozen pool of live SWE-intern Greenhouse postings (from the 16,933-entry
  listing, §26).
- `used_boards.json`: every board ever opened. A round is a fresh random
  draw from the boards *not* in it; the draw is added before the round runs.
- Boards used to develop a fix become training boards and are never used to
  verify it (§34: "the point is to not use the same testing group").
- Postings that closed between the freeze and the run redirect to the
  board's listing page; they are logged as closed and excluded from every
  count.

### The per-batch loop

1. **Navigate** the tab to the posting (`force: true` past the "Leave
   site?" dialog the dry-run submit leaves behind).
2. **Wait** until the page carries an `aria-invalid` element — the sign
   that the fill has run and the dry-run submit has asked the form — or 30 s.
   Never longer: a wait past the debugger's 45 s freezes the reader.
3. **Read** the page: count green and amber outlines, list every invalid
   field's label, note `visibilityState`. Read the console for the
   `applied:` line, the `timing:` line and every `form wants:` line.
4. **Log** one row per board to the ledger: filled, could-not-enter, what
   the form still wanted, a note.
5. **Classify** each want. `plan said FILL` or an orange note is a filler
   defect. `plan said review` against a question the profile could answer
   is a coverage gap (an alias, a derivation, a missing profile field).
   Essays, consents and bespoke questions are the expected residue.
6. **Diagnose** on that page: inject a probe to inspect the widget (fiber,
   instance, `loadOptions`), fetch the board's schema to see the option list
   and `required` flag, compare with what the plan carried.
7. **Fix**, test, commit, bump the manifest version, push, open the PR,
   write the DECISIONS entry.
8. **Hand over**: ask Victor to reload the extension, and measure nothing
   against a version he has not confirmed. Round 2 ran on the 0.4.9 he
   confirmed (§34); rounds 3–5 on the versions named in §38.
9. **Draw new boards** and go again. A defect is never re-verified on the
   board that revealed it.

### The visibility constraint

Greenhouse does not hydrate a hidden tab and its re-render wipes early
writes (§37), and macOS counts an occluded window as hidden. Victor worked
in another window during the rounds, so visibility came and went. Every
read reports `visibilityState`; a "0 filled" on a hidden page is never
logged as a defect; a page that filled while hidden is re-run visible. The
extension itself now waits for visibility before writing, which is the
product-side consequence of the same constraint.

### Mistakes in the process, and what they changed

- **Verifying in the wrong world.** Page-world probes passed for days while
  the installed extension's select driver had never worked (§35). Rule: a
  probe is for understanding a widget; sign-off comes only from the
  installed extension, on a real page, with its console read back.
- **Checking structure instead of running.** Ids matched the API on
  Duolingo and the first real fill threw on the fifth field (§21). Rule: a
  change to the fill layer is not done until a real plan has been applied
  and read back.
- **Reading too early.** ZipRecruiter looked like a failure until a second
  read (§38). Rule: wait for the form's own validation, not a timer, and log
  the visibility state with the count.
- **Waiting too long.** A read that waits on a hidden tab longer than the
  debugger's 45 s freezes the reader, not the page (§38). Rule: no single
  read waits more than 30 s.
- **Trusting a count from a hidden tab.** NISC's "still wants 0" was an
  un-hydrated form (§34). Rule: a dry-run result on a hidden page is not a
  result.
- **Testing on the training board.** Early fixes were confirmed on the
  Duolingo page they were built against. Rule: fixes are confirmed on the
  next draw, never on the board that revealed them.
- **Claiming without a sample size.** "No form offers a no-preference
  option" from 57 postings; 156 found one. Rule: quote the sample size with
  the claim.
- **A record ahead of the work.** A patch script that failed halfway left a
  commit without the tests its PR described; the tests followed in
  `6239a82`. Rule: read the test count in the output before writing the PR
  body.

### The standing rules, in the applicant's words

Each of these is recorded in DECISIONS or the working notes, and each
changed the design:

- **Measure, never assume.** "lets never assume anything we must test
  against real world data and collect that data then come to a conclusion
  this will avoid future mistakes."
- **Design before building.** "think about what to build first and then
  build it dont spur of the moment decide to build."
- **Test for real.** "you must always test and then test and then test";
  "it's like testing vs real life."
- **Exact options only.** "when you fill something out you must select the
  exact thing that the select menu provides."
- **Speed.** "if it is slower than by hand then what is the point";
  "I'm expecting 10 ms for each option"; "try to do things in parallel."
- **Generality.** "don't fit this for only Duolingo — the purpose is this
  extension works across all Greenhouse applications."
- **New boards every round.** "the point is to not use the same testing
  group."
- **A CR per iteration.** "make sure to keep updating crs every time we make
  a change to firstplay"; "like for every iteration we made include new cr."
- **A thinking agent, bounded.** "some agent that can think should be
  allowed to exist" — built as a calibrated choice with a refusal option,
  never a writer (§25).
- **Never submit.** "don't actually apply and submit jobs but practice and
  see."

---

## 5. The survey, as it stands

Boards are held out: a frozen pool of live SWE-intern postings, a ledger of
boards already used, a fresh draw every round, never the same board twice.
"Filled" is the extension's own count of green fields; "could not enter" is
the count of fields where the plan had a value the widget would not take —
the only number that measures the extension rather than the profile.

| round | boards (live) | filled | could not enter | boards affected |
|---|---|---|---|---|
| 1 | 2 | 46 | 0 | — |
| 2 | 12 | 182 | 1 | clockworksystems |
| 3 | 9 | 149 | 0 | — |
| 4 | 17 | 252 | 1 | pacificfusion |
| 5 | 23 | 355 | 19 | lightmatter |
| 6 | 35 | 593 | 0 | — |
| 7 | 3 | 48 | 0 | — |
| **all** | **101** | **1625** | **21** | |

Round 1 in the ledger holds the two boards the extension was developed
against (Duolingo, Coinbase); DECISIONS §34 counts fourteen boards opened
before round 2 as the training set — the difference is the boards of the
§31 structural survey and the §22 dropdown survey, which were probed but not
logged as fills. Postings that closed between the freeze and the run are
excluded (9 so far). The per-board log with what each form still
wanted is `survey_results.jsonl` in the working notes; the aggregates are in
DECISIONS §36 and §38. Round 6 is the draw toward the 100-board target Victor
set before moving on to Ashby, Workday and Oracle.

---

## 7. Notes for whoever edits this next

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
