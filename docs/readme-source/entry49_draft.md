**49. One hundred open internships: the date picker, the French board, and
the checkbox the check could not name (2026-10-12, extension 0.4.54, backend
DECISIONS §58).**
*Why.* A live round of 100 internship applications on 0.4.52 — 53
Greenhouse, 47 Ashby — filled 821 / 1 and 360 / 9 (filled / failed). Nine of
the ten entry failures were one widget: Ashby's Date field ("Graduation
Date", "Expected Graduation Date", "When can you start a new role?") is
react-datepicker. The filler set the input's text ("May 2028") with the
native setter; the display showed it, but the picker's selected date stayed
null, so Ashby's form state was empty, the read-back said "wrote it but the
field now reads something else", and the drift re-check re-wrote the same
text. Typing "05/15/2028" with key events did not reach it either. Measured
live on TensorWave: clicking the input opens a popper with a custom header
(an `h4` reading the month and year, two buttons, no selects), day names and
35 day cells labelled "Choose Monday, May 15th, 2028", the adjacent months'
cells marked `--outside-month`. The tenth failure was localisation: Haven
Interactive's form is French, the Country option reads "États-Unis +1", and
"United States" matched nothing — which then left Phone wanted. Separately,
the DOM required check reported consent checkboxes on Signifyd, Attentive
and InternshipList as "not in plan" although the plan had an entry for each:
Greenhouse renders a one-box question `question_N` as the input
`question_N-labeled-checkbox-0`, and neither `locate` nor the check mapped
that id back to the key. On Rugged Robotics a multi-checkbox group ("Are you
interested in a Spring Co-Op, Summer Internship, or Fall Co-Op?") was "plan
said FILL but form still wants": the check read the group through its first,
unchecked box.
*What changed.* A date-picker driver, chosen whenever the located input
sits inside `.react-datepicker-wrapper`, in the picks tier since it is a
click sequence: parse the stored text ("May 2028", "May 15, 2028",
"2028-05-15", "05/15/2028", a bare year → January), click the input to open
the popper (focus plus a pointer sequence if a plain click does not), read
the header's month and year, press previous or next until it is the stored
month (bounded at 120 steps, re-reading the header after every press),
click the day cell whose aria-label names the month, day ordinal and year
and that is not of an adjacent month, then read back: the input must hold a
date with the stored year and the popper must have closed (Escape, then
blur, if not). A month-year takes the 1st and the green outline's tooltip
says "FirstPlay chose the 1st of your stored month"; every step that fails
returns its own reason ("date picker: could not reach May 2028 in 120
steps", "the calendar did not open", "no day cell for …"), so it is a
review, never a silent success. The drift re-check and the learning capture
compare dates as dates, so the picker's "05/01/2028" for a stored "May
2028" is neither drift nor a correction (§54: a widget's rendering is never
the applicant's words). The backend now sends `dial_code` ("+1") and `iso2`
("US") on the synthetic Country entry (§58); when the exact or prefix match
fails on a phone-country list ("<name> +<digits>"), the option is the one
carrying that dial code if exactly one does, else the one whose exposed ISO
code is the plan's (+1 is United States, Canada, Puerto Rico and more), else
a small table of the US, Canada and UK under their French, Spanish, German
and Portuguese names, compared with accents folded; "several countries share
+1; pick yours" is the refusal when nothing tells them apart. An older
backend that sends no hints still gets the name table. `locate` now finds
`question_N` at `question_N-labeled-checkbox-0` (or `-radio-0`), the first
input standing for the group as `choiceCandidates` already assumed; the DOM
check treats a checkbox or radio group as one control — held when any box is
checked, reported once, under the plan's key and the question's label — and
the learning reader groups boxes by that id prefix as well as by name.
*Measured.* Node tests still 4 files, all green: `fill.test.mjs` gains the
country fallback (French list with and without hints, a list that exposes
ISO codes, the shared-+1 refusal, a non-country list left alone), `parseDate`
over eleven shapes, and the date picker driven on a stub popper modelled on
the TensorWave measurement — October 2026 to May 2028 is nineteen presses on
next, March 2026 seven on previous, the greyed May 1st in April's grid is
never the cell clicked, the tooltip carries the note, a dead picker and an
unreachable month each return their reason; `content.test.mjs` gains the
consent box and the multi-checkbox group through the real `locate`,
`applyPlan` and `domRequiredCheck` (wanted once each before the fill, under
the plan's keys; nothing wanted after; a group the plan never knew is one
row); `learn.test.mjs` gains the date rule. Live re-check on 0.4.54, window
on screen: TensorWave's Graduation Date — [picked / why], read-back
[input value], drift [n]; Haven Interactive's Country — [chosen option],
Phone [filled / wanted]; Signifyd / Attentive / InternshipList consent rows
[gone / still "not in plan"]; Rugged Robotics' co-op group [filled, not
wanted / still wanted]. Ashby totals over the re-run boards [filled /
failed]; Greenhouse [filled / failed]; `still_required` on the re-run
boards [before → after].
