# FirstPlay Autofill — privacy

Plain language, written to match what the code does as of extension 0.4.52.
Where the code changes, this file changes in the same commit.

## What the extension holds, and where

Everything the extension keeps is in **this browser's extension storage**
(`chrome.storage.local`), **unencrypted**, on this computer only:

- your profile (name, contact details, education, work authorisation,
  preferences, standing consents, and only the self-identification answers
  you chose to store);
- the résumé and transcript you attached in the popup, as file bytes;
- answers the learning loop stored for you, if you turned it on, and facts it
  proposes;
- the questions pages asked that your profile could not answer (label, page);
- a log of fields it knew but could not enter (page, label, the widget's
  reason with any quoted value blanked — no values; until 0.4.52 the reason
  was stored as the widget wrote it, value included);
- the last run's record (counts, timings, each field's key, label, source and
  result, what the form still wanted, which backend host and engine
  answered — no values), which *Copy diagnostics* in the popup exports;
- a random install token used for rate limiting, not tied to you.

Plans the backend returned are kept in session storage until the browser
closes, or until you press *Forget cached plans*.

No account exists, and no server holds a copy of your profile.

## What leaves your machine, and to whom

**1. The backend** — `https://firstplay-backend.onrender.com` by default
(hosted on Render), or a backend you run yourself (`http://localhost:8000`),
chosen in the popup under *Advanced: backend*. The popup shows, in one
line, which one is in use right now. A local backend is used only if you
typed its address there, or if you turned on *Use a backend running on this
machine* (off by default); until then nothing is ever sent to a local port.
(Before 0.4.52 the extension probed port 8000 on its own and used whatever
answered, over plain HTTP, without saying so.)

- With **every plan request**: your **whole profile**, including
  self-identification answers and consents, together with the form's
  definition (the Greenhouse or Ashby field list). The backend uses it to
  decide what each field gets, answers, and keeps nothing. It does not store
  or log request bodies. Nothing is written to disk or to a database. (The
  server process keeps an in-memory cache of menu-option matches for its
  lifetime; it is being changed to hold no stored answer text.) Render keeps
  ordinary access logs — method, path, status — which we do not control.
- With **every learn request** (only if you turned learning on): your whole
  profile again, plus what you typed or picked in fields the fill left to
  you, with the field's label and the company. The backend decides whether
  that is an answer to replay or a fact to propose, and returns the profile
  to store **here**. Self-identification and consent answers are never
  captured by the learning loop.
- Transport is HTTPS to the hosted backend.

**2. The model provider** — OpenRouter, called by the backend, never by the
extension. The backend sends it field labels and option texts, earlier
answers on the same form, and the **non-protected** parts of your profile:
work authorisation, education, preferences, background facts, learned facts,
current location, employers. It is asked bounded questions only: does a
stored fact answer this field, and which of these options is it. It never
composes text under your name.

**Never sent to the model:** your self-identification answers (race,
ethnicity, gender, veteran status, disability, sexual orientation and the
like) and your standing consents. Those are replayed exactly as you stored
them or left for you. OpenRouter's own data policy governs what it retains.

**3. Greenhouse's board API and Ashby's GraphQL API** receive the posting's
identifiers only (board, job id), to fetch the form's definition. No profile
data goes there.

**4. The employer's form** receives every value the extension writes, exactly
as if you had typed it. Two things to know:

- **Ashby saves a draft on the employer's server as you fill**, before any
  submit, including self-identification answers you chose to store. That is
  Ashby's behaviour for any typing in its form; the extension's fill triggers
  it like typing does. Nothing is typed before the page's plan has arrived
  (until 0.4.52 the previous page's stored location was typed into the
  location field early, to warm its lookup; it no longer is).
- **A company's own careers page is never filled.** When an employer embeds
  a Greenhouse form on its site, the form lives in a Greenhouse frame and
  only that frame is filled; the company's page receives none of your
  answers and not your résumé. The extension acts only on
  `job-boards.greenhouse.io`, `boards.greenhouse.io`, `jobs.ashbyhq.com` and
  their vendors' own subdomains; *Fill this page* on any other site first
  says what it will do and waits for a second click.
- **The "still wants" check never presses Submit.** After the fill the
  extension lists what the form still requires by reading the page: the
  form definition's required flags and the form's own markers (`required`,
  `aria-required`, the `*` on a label, any field the form has already marked
  invalid), against what each field now holds. No button is pressed and no
  request is attempted. (Until 0.4.52, on Greenhouse only, this was done by
  pressing Submit inside a block on every way of sending; that click now
  exists only behind a developer setting, `firstplay.dryRun.click`, off by
  default, and even then a form that reads complete is never clicked.)

## What is never done

- **No submission.** The extension never submits an application, and never
  presses Submit — not even to check the form. You review and you press
  Submit.
- **No inference of protected characteristics.** The Hispanic/Latino question,
  race, gender, veteran and disability status are answered only from the
  exact answer you stored for that question, or left for you. Nothing is
  derived from another answer.
- **No model-written answers.** The model decides yes/no and which option;
  it never writes free text under your name.
- **Learning is off by default.** Until you turn it on, nothing you type is
  read or sent anywhere.

## Retention

- Backend: none. Each request is answered and forgotten.
- This browser: until you delete it (below) or remove the extension.
- Cached plans: until the browser closes, or *Forget cached plans*.

## How to delete

- The profile: open the popup, *Advanced: raw profile (JSON)*, replace the
  text with `{}` and press *Save raw profile*. The editor above it then shows
  everything empty.
- The résumé or transcript: the ✕ button beside each.
- The log of fields it could not enter: *Clear* under that heading.
- Everything at once: remove the extension at `chrome://extensions`. Chrome
  deletes its storage with it.

Nothing needs deleting on any server, because nothing is kept on one.

## Questions

Open an issue on the repository, or read the code: `src/background.js` is the
only file that talks to the network, and every request it makes is listed
above.
