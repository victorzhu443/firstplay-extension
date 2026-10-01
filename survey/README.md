# Survey data

Every number in the README's iteration log and in the backend's
`docs/DECISIONS.md` comes from the files in this folder. They are appended
by hand after each page is read back — one line per application — and
never edited afterwards except to add a note. No applicant data: boards,
organisations, posting ids, counts, timings, and the labels of what a form
still wanted.

## Files

| file | what |
|---|---|
| `survey_results.jsonl` | Greenhouse: one line per board, rounds 1–10. `filled` = fields the extension filled (its own count); `failed` = "known but could not be entered" — the plan had a value the widget would not take, the only number that measures the extension rather than the profile; `wants` = what the form's own validation still asked for after the fill; `closed: true` = excluded (posting closed since listing, employer-hosted redirect, network error) |
| `ashby_results.jsonl` | Ashby: one line per application, round `A0-dom-baseline` (before the API path), `A1` (the hundred on the API path), `A1-rerun` (after fixes). Adds `review` (left for the applicant), `fill_ms` (the fill phase from the page's own record), `plan_ms` (first sight to plan ready) |
| `ashby_results.jsonl`, round `R48-1` | The first held-out round of "everything except the essays" (DECISIONS §48): 12 unused organisations, run 2026-10-01 in a hidden tab (`hidden_tab: true`). Adds `engine` (the backend engine fingerprint the plan came from) and `wants` (what the local required check still listed after the fill, as `label|what the plan said`; a `FILL` there is a fill that did not land — the Ashby yes/no defect fixed in 0.4.39) |
| `ashby_results.jsonl`, round `R48-2` | The Ashby hundred of 2026-10-01 on extension 0.4.39 with the applicant's round-1 facts answered: 100 unused organisations, 719 filled, 250 for the applicant, 1 could-not-enter (Rivian's Location geocoder), median fill 110 ms, 83 under one second, 22 forms with nothing left. `wants` as in R48-1 |
| `draws/draw_r48_2_ashby.json`, `draws/draw_r48_2_gh.json` | The R48-2 draws: 100 unused Ashby organisations and 100 live unused Greenhouse postings (68 boards) |
| `draws/draw_r48_gh.json`, `draws/draw_r48_ashby.json` | The R48 draws: 12 live, unused Greenhouse postings (board, id, company, title, question count, url) and 12 unused Ashby organisations (org, posting id, title, field count) |
| `rerun_notes.jsonl` | Re-runs of boards that had failed, with the version that fixed them |
| `used_boards.json` | The never-reuse ledger: every Greenhouse board (`used_boards`) and Ashby organisation (`ashby_orgs`) ever drawn. A round is drawn from what is not in here |
| `draws/round*.json`, `draws/ashby_*.json` | The held-out draws, in order. Round 10 and the Ashby hundred were drawn from the Simplify Summer 2026 / Summer 2027 / New-Grad lists, liveness-checked against the ATS's own API before the draw |

`docs/readme-source/` holds the iteration log (`readme_log.md`), the process
section (`readme_process.md`) and `build_readme.py`, which regenerates the
README's survey table from these files:

```bash
python3 docs/readme-source/build_readme.py docs/readme-source README.md
```

## Where it stands (2026-09-29)

### Greenhouse

| round | live boards | filled | could not enter |
|---|---|---|---|
| 1 | 2 | 46 | 0 |
| 10 | 5 | 78 | 0 |
| 2 | 12 | 182 | 1 |
| 3 | 9 | 149 | 0 |
| 4 | 17 | 252 | 1 |
| 5 | 23 | 355 | 19 |
| 6 | 35 | 593 | 0 |
| 7 | 3 | 48 | 0 |
| 9 | 10 | 146 | 0 |
| **all** | **116** | **1849** | **21** |

16 boards excluded. Zero "could not enter" since extension 0.4.19.

### Ashby

| | |
|---|---|
| applications (organisations) | 100 |
| filled | 702 |
| left for the applicant | 246 |
| could not enter, first pass → after fixes | 4 → 0 |
| fill, median | 88 ms |
| fill under one second | 83 / 100 |
| fill, worst | 3465 ms (a Location geocoder) |

Two of the four first-pass failures were an employer-scoped geocoder that
never offers a US city; from 0.4.38 those read as a mismatch for the
applicant, not a filler failure.
