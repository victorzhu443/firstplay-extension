**Profile editor and "questions from the last page" (0.4.49).**
*Why.* Victor, 2026-10-12, with an IMC form whose education start date,
high-school graduation year, test type, SAT and ACT were empty: "you also
need to be able to edit this stuff and ask the user for this information."
Maintaining the profile by pasting JSON is fine for the person who wrote
the engine and wrong for everyone else.
*What.* The popup renders the profile as a form from the backend's own
onboarding registry (`GET /api/autofill/profile-schema`): one collapsible
group per section — about you, education, work authorization, preferences,
standing consents, self-identification — each key an input with the
example as placeholder and the setup note as help, ordered by how many real
application fields the key answers. Save writes only the keys that changed
(replayed answers, learned facts and the skip list are untouched) and
drops the cached plans so the next page plans afresh. The raw JSON stays
under "Advanced: raw profile" and the two views refresh each other.
When a plan recognises a question the profile cannot answer, the entry
carries `needs_fact` (section, key, prompt, example, note); the page sends
those to the popup, which shows them at the top as "This page asked for N
things your profile doesn't have", each with an input, Save and Skip (a
skipped key stays quiet for 30 days). Saving writes the value into the
profile and the next visit to that page fills it. Self-identification asks
say so and are never inferred. The run record carries `asks`.
*How to use.* Open the popup after a fill; answer what it asks, or open a
section and fill in what you know. Nothing but the schema request leaves
the machine.
