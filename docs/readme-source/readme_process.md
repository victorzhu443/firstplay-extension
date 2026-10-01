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

