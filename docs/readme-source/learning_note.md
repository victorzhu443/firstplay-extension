## Learning from what you do (0.4.40)

*Why.* Every field the fill leaves to you is a question the tool could not
answer from your profile. You answer it anyway, on the form, by hand — and
until now that answer was gone the moment you pressed Submit. Victor: "build
an agent that, as we use it, improves and understands what I do to answer
questions and starts being able to answer my own questions."

*What changed.* A capture script (`src/learn.js`) watches the controls the
plan knows about after each fill. When you answer a field the plan left to
you, or change a value it wrote, that one observation — the question, its
options, what the plan had, what you put — goes to your local backend
(`POST /api/autofill/learn`, 127.0.0.1 only) together with your profile. The
backend decides what it means and returns the profile to store: your exact
answer is kept under `answers` so the same question is filled next time, and
a value that looks like a reusable fact comes back as a *proposal*. Nothing
is written to your facts without your click.

*When it sends.* After a change settles (1.5 s after a pick or a blur, 4 s
after the last keystroke, never while the control still has focus), when
you click Submit (a capture-phase listener; it never prevents, delays or
triggers the submission), and when the page is hidden or left. Each field's
value is sent once per distinct value.

*What is never learned.* File inputs, passwords, protected characteristics
(the EEOC block, demographic questions, veteran/disability/race/gender
keys), consents and attestations, and anything the plan attached. The
backend filters the same classes again. Values are never logged to the
console — only counts.

*How to use it.* Open the extension popup. "Learned from you" shows how
many of your answers are replayed on repeat questions, and lists proposed
facts as `key = value` with the question it came from. **Accept** writes it
to your profile (into an existing empty key if the proposal names one,
otherwise under `learned`); **Ignore** forgets it and stops it being
proposed again. The outcome record on each page carries `learned_sent`.

*Storage keys.* `firstplay.profile` (unchanged; the backend's returned
profile replaces it), `firstplay.learning.proposals`,
`firstplay.learning.ignored`, `firstplay.learning.stats`. A changed profile
changes the plan-cache key (the profile is hashed into it), so no stale plan
is served after a learn.
