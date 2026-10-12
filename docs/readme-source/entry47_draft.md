**47. The outside audit, extension side: no inferred ethnicity, every write
read back, a privacy page that matches the code (2026-10-12, extension
0.4.51, backend DECISIONS §55).**
*Why.* An outside audit of both repos (AUDIT_REPORT.md) found one High
finding in the extension and a cluster of Mediums. H1: the Greenhouse
Hispanic/Latino question was answered by a substring test on the stored
race — "White (Not Hispanic or Latino)", Ashby's own wording, read as Yes;
"I don't wish to answer" read as No — under the applicant's name, with a
green outline, and no model involved, so no gate caught it. M4: text
inputs, native selects, radio and checkbox clicks all reported filled
without reading the control back, a lone checkbox asked "No" reported a
fill after doing nothing, and `locate`'s label fallback took the first of
two same-labelled fields. M6 and L4: the hosted backend ran without a
model key, said `model_degraded: false`, and its deterministic plans were
cached for six hours; a failed health fetch keyed the cache on "unknown".
M5: the popup said protected characteristics "never sit on a server",
which is true of storage and false of transit — the whole profile is
POSTed with every plan and learn request. M3: the dry run's `blocked`
list never reached the run record, so a run where nothing was blocked
and one where the block was bypassed looked the same afterwards. L7: the
plan and the résumé bytes went into the page's world whether or not the
page could use them.
*What changed.* The backend now carries the applicant's own
`hispanic_ethnicity` answer as a plan entry (§55); 0.4.51 writes that
entry exactly or leaves the question outlined for the applicant and
`race` unmounted, both counted as review — nothing is derived from the
stored race any more, and an older backend that sends no such entry
writes nothing. Every instant write is read back after one frame: text
by normalised value (phones by digits, since masks reformat), native
selects by value and option text, radios and checkboxes by `checked`; a
"Yes" that does not stay checked is a failure, a "No" over a clear box is
a fill. A label that two controls share locates nothing, with the reason
in the miss log. The run record gains `fields` — key, label, source,
confidence, state, result, no values — so a model-decided fill and a
replay can be told apart in survey rows, plus `blocked` and
`submit_clicked`. No plan is cached when the backend reports no model,
and none when health is unreachable. Review, skipped and sibling entries
cross into the page's world without their values; the résumé only when
the page has a file input. The popup, config and README now say what is
true: the profile's only stored copy is in this browser, unencrypted; the
whole profile travels to the backend with every request and is used and
dropped; its non-protected parts may reach the model; protected answers
and consents never do. docs/PRIVACY.md says the same in plain language
with every data flow, including Ashby's server-side draft autosave.
*Measured.* ⟨coordinator: live numbers⟩ — a Greenhouse board with the
two-question EEO block, with the stored answer set and unset; a board
with a masked phone input; an Ashby form with a lone required checkbox;
the `fields` array and `blocked` list read from `data-firstplay-outcome`;
node tests ⟨N⟩ (+⟨n⟩, fill.test.mjs new).
