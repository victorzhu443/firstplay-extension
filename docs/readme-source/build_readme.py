import json, sys, pathlib, collections

S = pathlib.Path(sys.argv[1])
README = pathlib.Path(sys.argv[2])
rows = [json.loads(l) for l in (S / "survey_results.jsonl").open() if l.strip()]
live = [r for r in rows if not r.get("closed")]
by = collections.defaultdict(list)
for r in rows:
    by[r["round"]].append(r)
tot_f = sum(r["filled"] for r in live)
tot_x = sum(r["failed"] for r in live)
closed = len(rows) - len(live)

old = README.read_text().splitlines(keepends=True)
i1 = next(i for i, l in enumerate(old) if l.startswith("## 1. Using it"))
i3 = next(i for i, l in enumerate(old) if l.startswith("## 3. "))
i6 = next(i for i, l in enumerate(old) if (l.startswith("## 6.") or l.startswith("## 7. Notes")))
sections_1_2 = "".join(old[i1:i3])
tail = "".join(old[i6:]).replace("## 6. Notes", "## 7. Notes", 1)

header = f"""# FirstPlay Autofill — Chrome extension

Fills job applications from answers you have already given, on the real form,
in about two seconds. You review what it wrote and you press Submit. **It never
submits for you.**

Measured so far on **{len(live)} live Greenhouse postings** on boards never opened
before (a fresh draw every round): **{tot_f} fields filled**, **{tot_x} cases** where
it knew the answer but could not enter it — all {tot_x} on three boards whose
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

"""

log = (S / "readme_log.md").read_text()
process = (S / "readme_process.md").read_text()

round_rows = ""
for k in sorted(by, key=lambda r: (isinstance(r, str), str(r).zfill(3))):
    v = by[k]
    l = [r for r in v if not r.get("closed")]
    f = sum(r["filled"] for r in l)
    x = sum(r["failed"] for r in l)
    bad = [r["board"] for r in l if r["failed"]]
    round_rows += f"| {k} | {len(l)} | {f} | {x} | {', '.join(bad) or '—'} |\n"

survey = f"""## 5. The survey, as it stands

Boards are held out: a frozen pool of live SWE-intern postings, a ledger of
boards already used, a fresh draw every round, never the same board twice.
"Filled" is the extension's own count of green fields; "could not enter" is
the count of fields where the plan had a value the widget would not take —
the only number that measures the extension rather than the profile.

| round | boards (live) | filled | could not enter | boards affected |
|---|---|---|---|---|
{round_rows}| **all** | **{len(live)}** | **{tot_f}** | **{tot_x}** | |

Round 1 in the ledger holds the two boards the extension was developed
against (Duolingo, Coinbase); DECISIONS §34 counts fourteen boards opened
before round 2 as the training set — the difference is the boards of the
§31 structural survey and the §22 dropdown survey, which were probed but not
logged as fills. Postings that closed between the freeze and the run are
excluded ({closed} so far). The per-board log with what each form still
wanted is `survey_results.jsonl` in the working notes; the aggregates are in
DECISIONS §36 and §38. Round 6 is the draw toward the 100-board target Victor
set before moving on to Ashby, Workday and Oracle.

---

"""

r6 = by[max((k for k in by if isinstance(k, int)), default=max(by, key=str))]
r6_live = [r for r in r6 if not r.get("closed")]
subs = {
    "{r6_logged}": str(len(r6)),
    "{r6_closed}": str(len(r6) - len(r6_live)),
    "{r6_live}": str(len(r6_live)),
    "{r6_filled}": str(sum(r["filled"] for r in r6_live)),
    "{r6_failed}": str(sum(r["failed"] for r in r6_live)),
    "{r6_boards}": ", ".join(r["board"] + (" (closed)" if r.get("closed") else "") for r in r6),
}
for k, v in subs.items():
    log = log.replace(k, v)

out = header + sections_1_2 + log + process + survey + tail
README.write_text(out)
print("lines:", len(out.splitlines()), "| live", len(live), "filled", tot_f, "failed", tot_x, "closed", closed)
