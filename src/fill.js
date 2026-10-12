/**
 * Writing a plan into the page.
 *
 * Everything here was shaped by reading a live Greenhouse form rather than
 * assumed, and three of those readings overturned the obvious implementation:
 *
 *   1. **Fields are found by `id`, not `name`.** 17 of 19 plan fields on a real
 *      posting resolved by id; `name` was absent on most.
 *
 *   2. **An API field name is not always the DOM id.** The board API calls one
 *      EEOC field `race`; the page renders it as `hispanic_ethnicity`. Matching
 *      on the key alone left a protected field unfilled with no error at all,
 *      so there is a label fallback.
 *
 *   3. **There are no `<select>` elements.** Every dropdown is react-select — a
 *      text input with `role="combobox"`, no hidden input carrying the value,
 *      and no listbox in the DOM until it opens. Assigning `.value` does
 *      nothing, because React owns the value and re-renders over it. It has to
 *      be driven the way a person drives it: focus, type, wait for the filtered
 *      option, commit.
 *
 * And one hard limit: **`input[type=file]` cannot be set by script.** Browsers
 * forbid it deliberately. A résumé is always attached by hand, so it is
 * reported rather than attempted.
 *
 * Classic script — see the note in extract.js.
 */
var FirstPlay = FirstPlay || {};

(function (ns) {
  "use strict";

  const OUTLINE_FILLED = "2px solid #0a7c3f";
  const OUTLINE_REVIEW = "2px solid #d97706";
  const OUTLINE_ATTACH = "2px dashed #2563eb";

  /**
   * A wait that keeps its word in a background tab. Chrome throttles timers
   * in hidden pages (to one a second, then one a minute), so a fill in a tab
   * the applicant has switched away from would crawl or stall. Message ports
   * are not throttled — React's own scheduler relies on that — so when the
   * page is hidden the wait is a chain of MessageChannel ticks until the
   * deadline, each tick yielding to the event loop so fetches and renders
   * still land. When visible, a plain timer.
   */
  function sleep(ms) {
    if (document.visibilityState === "visible") return new Promise((r) => setTimeout(r, ms));
    const deadline = performance.now() + ms;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (performance.now() >= deadline) { channel.port1.close(); resolve(); }
        else channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
    });
  }

  function normalise(text) {
    return (text || "").toLowerCase().replace(/[^\w\s+#&]+/g, " ").replace(/\s+/g, " ").trim();
  }

  const US_STATES = {
    al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
    ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho",
    il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
    me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
    ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada",
    nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina",
    nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
    ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas",
    ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia",
    wi: "wisconsin", wy: "wyoming", dc: "district of columbia", us: "united states",
    usa: "united states",
  };

  /** "ithaca ny" -> "ithaca new york", so a stored place can meet a geocoder's wording. */
  function expandPlaces(normalised) {
    return normalised.split(" ").map((w) => US_STATES[w] || w).join(" ");
  }

  /**
   * The one option a wanted value unambiguously names, among what a menu
   * actually offers. Exact text first; otherwise a prefix match only when
   * exactly one option has it. Anything else is nobody's answer: the filler
   * must select what the menu provides, or leave the field and say so.
   */
  function pickOption(options, textOf, value) {
    const wanted = normalise(value);
    const wantedPlace = expandPlaces(wanted);
    const texts = options.map((o) => normalise(textOf(o)));

    // Geocoders repeat an entry (Scale AI offered "Ithaca, New York, United
    // States" twice among six); identical texts are one answer, so
    // uniqueness is judged on distinct texts and the first copy is taken.
    const unique = (hits) => {
      const distinct = new Set(hits.map((o) => texts[options.indexOf(o)]));
      return distinct.size === 1 ? hits[0] : null;
    };

    let hits = options.filter((o, i) => texts[i] === wanted || texts[i] === wantedPlace);
    if (hits.length) return unique(hits);

    hits = options.filter((o, i) => texts[i].startsWith(wanted) || texts[i].startsWith(wantedPlace));
    return hits.length ? unique(hits) : null;
  }

  /**
   * React tracks the last value it rendered and skips its handler when a plain
   * assignment leaves that tracker untouched. Going through the prototype's
   * setter and dispatching `input` is what makes React observe the change.
   */
  function setNativeValue(el, value) {
    const prototype = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;

    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Every control on the page that could be the field `entry` refers to. */
  /**
   * The control a person interacts with for a field whose id sits on a hidden
   * input. Greenhouse's education block (measured on Duolingo, 2026-09-27)
   * keeps `educations[0].degree_id` as a hidden value and renders the widget
   * next to the label `<id>--label`; the widget is what has to be driven.
   */
  function visibleWidgetFor(hidden) {
    const label = document.getElementById(`${hidden.id}--label`);
    const box = (label && label.parentElement) || hidden.parentElement;
    if (!box) return hidden;

    // Duolingo's combobox renders TWO search inputs: the first carries the
    // ARIA attributes but has tabindex="-1" and never receives typing; the
    // second is the one a person types into. Every scripted attempt at the
    // first showed nothing; the second works with the native setter. Prefer
    // focusable inputs, and the last of them.
    const inputs = Array.from(
      box.querySelectorAll('input:not([type="hidden"]), textarea, select')
    ).filter((el) => el.tabIndex >= 0 && el.offsetParent !== null);
    const typed = inputs.length ? inputs[inputs.length - 1] : null;
    const button = box.querySelector('button[aria-haspopup="listbox"]');

    if (typed) {
      // A text input beside a listbox trigger is an autocomplete, even when
      // the ARIA lives on its decoy twin. Remember the hidden input: its value
      // is the real proof that a suggestion was taken.
      if (box.querySelector('[aria-haspopup="listbox"], [role="listbox"]')) {
        typed.dataset.firstplayAutocomplete = "1";
        typed.dataset.firstplayHidden = hidden.id;
      }
      return typed;
    }
    return button || hidden;
  }

  const GREENHOUSE_EDUCATION_IDS = [
    // The location block's submitted name is `location`; the standard
    // renderer's control is `candidate-location` (Mill, Clockwork, Garda,
    // Verkada all left "Location (City)" wanting until this line).
    [/^location$/, "candidate-location"],
    [/^educations\[(\d+)\]\.school_name_id$/, "school--$1"],
    [/^educations\[(\d+)\]\.degree_id$/, "degree--$1"],
    [/^educations\[(\d+)\]\.discipline_id$/, "discipline--$1"],
    [/^educations\[(\d+)\]\.start_date\.month$/, "start-month--$1"],
    [/^educations\[(\d+)\]\.start_date\.year$/, "start-year--$1"],
    [/^educations\[(\d+)\]\.end_date\.month$/, "end-month--$1"],
    [/^educations\[(\d+)\]\.end_date\.year$/, "end-year--$1"],
  ];

  function renderedIdFor(key) {
    for (const [pattern, replacement] of GREENHOUSE_EDUCATION_IDS) {
      if (pattern.test(key)) return key.replace(pattern, replacement);
    }
    return null;
  }

  /** The control an entry names by key, id or name — never by label. */
  function locateByKey(entry) {
    const key = entry.field_key;

    // Ashby: every field's container carries data-field-path equal to the
    // API field's path, which is the plan's key. Exact, no label matching.
    const ashbyContainer = key && document.querySelector(`[data-field-path="${CSS.escape(key)}"]`);
    if (ashbyContainer) {
      const control = ashbyContainer.querySelector(
        'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select, [role="combobox"]'
      );
      if (control) return control;
      if (ashbyContainer.querySelector('input[type="radio"], input[type="checkbox"]')) return ashbyContainer;
    }

    const rendered = key && renderedIdFor(key);
    const byRendered = rendered && document.getElementById(rendered);
    if (byRendered) return byRendered;

    const byId = key && document.getElementById(key);
    if (byId && (byId.type || "").toLowerCase() === "hidden") return visibleWidgetFor(byId);
    if (byId) return byId;

    const byName = key && document.querySelector(`[name="${CSS.escape(key)}"]`);
    if (byName) return byName;

    // An Ashby option group is keyed by the id prefix its options share.
    if (key && /-labeled-(checkbox|radio)$/.test(key)) {
      const first = document.querySelector(`[id^="${CSS.escape(key)}-"]`);
      if (first) return first;
    }

    // Ashby prefixes radio-group names with a per-page-load UUID —
    // `d5e6e981-…__systemfield_eeoc_gender` on one load, a different UUID on
    // the next. Only the `_systemfield_…` suffix is stable, so a key that
    // carries one is matched on the suffix. Within a single load the exact
    // match above already succeeds; this is what keeps a plan valid if the
    // page re-renders between reading and filling.
    const marker = key ? key.indexOf("_systemfield_") : -1;
    if (marker >= 0) {
      const suffix = key.slice(marker);
      const bySuffix = document.querySelector(`[name$="${CSS.escape(suffix)}"]`);
      if (bySuffix) return bySuffix;
    }

    return null;
  }

  function locate(entry) {
    return locateWithReason(entry).el;
  }

  /**
   * The control for an entry, or why there is none. By key first; then the
   * fallback that catches race -> hispanic_ethnicity, matched on the label's
   * text, which is the one thing the API and the DOM agree on. The label
   * match must be UNIQUE: "Other", "Please specify" and "Start date" each
   * appear twice on some forms, and the first of two same-labelled controls
   * is nobody's answer (audit M4). `why` is set only in that case, so the
   * miss log can say so instead of a value landing in the wrong field.
   */
  function locateWithReason(entry) {
    const byKey = locateByKey(entry);
    if (byKey) return { el: byKey };

    const wanted = normalise(entry.label);
    if (!wanted) return { el: null };

    const matches = new Set();
    for (const label of document.querySelectorAll("label")) {
      if (normalise(label.innerText) !== wanted) continue;
      const forId = label.getAttribute("for");
      const target = (forId && document.getElementById(forId)) || null;
      const nested = target || label.querySelector("input, textarea, select");
      // Ashby: the label's `for` names an id nothing carries, and the control
      // is a sibling inside the same field container.
      const container = nested ? null : label.closest('[class*="fieldEntry"], [class*="field-entry"]');
      const inContainer = container && container.querySelector('input:not([type="hidden"]), textarea, select');
      const control = nested || inContainer;
      if (control) matches.add(control);
    }

    if (matches.size === 1) return { el: matches.values().next().value };
    if (matches.size > 1) {
      return { el: null, why: `${matches.size} fields on this page share the label ` +
        JSON.stringify(String(entry.label || "").slice(0, 60)) + "; left for you" };
    }
    return { el: null };
  }

  /**
   * Does a text control hold what was written? Compared normalised; a phone
   * (a tel input, or a phone-shaped value) is compared by its digits, since
   * masks reformat and some add or drop the country code.
   */
  function textHolds(actual, written, type) {
    const a = String(actual === null || actual === undefined ? "" : actual);
    const w = String(written === null || written === undefined ? "" : written);
    if (normalise(a) === normalise(w)) return true;
    const phoneShaped = (type || "").toLowerCase() === "tel" || /^[\s\d()+.\-]{7,}$/.test(w);
    if (!phoneShaped) return false;
    const da = a.replace(/\D/g, ""), dw = w.replace(/\D/g, "");
    return dw.length >= 7 && da.length >= 7 && (da.endsWith(dw) || dw.endsWith(da));
  }

  /**
   * An autocomplete: an input with role=combobox whose suggestions arrive
   * after typing. Measured on Ashby's Location field (2026-09-27): the native
   * setter plus an `input` event brings a remote suggestion list
   * (`#aria-controls` of `[role=option]`) about 2 s later; clicking a
   * suggestion writes its full text ("Ithaca, New York, United States") into
   * the input and closes the list. Typing alone leaves the field unconfirmed.
   */
  /** Options currently offered to an autocomplete input, wherever the list is attached. */
  /** The listbox ids a field's own inputs point at — its list, never another field's. */
  function listIdsFor(el) {
    const ids = [el.getAttribute("aria-controls"), el.getAttribute("aria-owns")];
    // The field's own box is the SMALLEST ancestor holding a list pointer —
    // on Duolingo the decoy twin beside the typed input. A wider container
    // (a role="group" around a whole section) would hand a field its
    // neighbours' lists in DOM order, and Degree would read School's.
    // Bounded: at most three levels up, and never a container that also
    // holds other fields' inputs — an unbounded walk reached the whole form
    // on Coinbase and handed every select the phone widget's country list.
    let box = el.parentElement;
    for (let hops = 0; box && box !== document.body && hops < 3; hops += 1, box = box.parentElement) {
      const pointers = box.querySelectorAll("[aria-controls], [aria-owns]");
      if (!pointers.length) continue;
      const inputs = box.querySelectorAll('input:not([type="hidden"]), textarea, select');
      if (inputs.length > 2) break;
      for (const twin of pointers) ids.push(twin.getAttribute("aria-controls"), twin.getAttribute("aria-owns"));
      break;
    }
    return ids.filter(Boolean);
  }

  /**
   * Options currently offered to an autocomplete input, read only from the
   * list its own field points at. An earlier "whatever listbox is open"
   * fallback returned the School/Degree/Discipline lists to the Location
   * field on a live Duolingo run, before the geocoder had answered — so the
   * wait ended early with another field's options.
   */
  function suggestionsFor(el) {
    for (const id of listIdsFor(el)) {
      const list = document.getElementById(id);
      const options = list ? Array.from(list.querySelectorAll('[role="option"]')) : [];
      if (options.length) return options;
    }
    return [];
  }

  /**
   * An autocomplete: an input whose suggestions arrive after typing. Measured
   * on Ashby's Location field and Duolingo's School/Degree/Discipline
   * (2026-09-27): the native setter plus an `input` event brings the list
   * (remote on Ashby, ~2 s; local on Duolingo), clicking a suggestion writes
   * its text into the input and, on Duolingo, the chosen id into the hidden
   * field. Typing alone leaves the field unconfirmed.
   */
  /**
   * Start an autocomplete's search without waiting for it.
   *
   * When the page's window is not focused — always the case right after the
   * popup was clicked, and in a background tab — `focus()` moves
   * activeElement but fires no focus events, and a widget that opens on
   * focus never opens (measured on Duolingo). React listens to focusin.
   */
  function startAutocomplete(el, value) {
    el.focus();
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    setNativeValue(el, value);
  }

  /**
   * Pick from an autocomplete whose search was started earlier. Remote
   * geocoders (Ashby, Duolingo's location) can take seconds; local lists
   * appear within a frame, so the first check is immediate and the poll is
   * short. Duolingo's lists stay open while other fields are filled
   * (measured), which is what lets several searches run at once.
   */
  async function pickAutocomplete(el, value) {
    // Wait up to 1.5 s for the list the typed term brings; then shorten the
    // term and try again (two words, one word). Ashby's University field
    // filters a fixed list by substring: "Cornell University" matched
    // nothing where its option is "Cornell", and the old 8 s wait ended in
    // "no suggestions appeared" (Sierra, 9.2 s in this one pick).
    // A remote geocoder (Ashby's Location) answers in 0.4–3.3 s; a local
    // list answers in a frame. The full term gets the long wait; shortened
    // terms (punctuation stripped — "Ithaca," matched nothing) get a short
    // one. Espa: the retry fired at 1.5 s while the geocoder was still
    // working, and its late answer was read against the wrong term.
    const isGeocoder = /location|city/i.test(el.getAttribute("aria-label") || "") ||
      !!el.closest('[data-field-path="_systemfield_location"]') || el.id === "candidate-location";
    const clean = (t) => t.replace(/[,.;:]+$/, "").trim();
    const terms = [String(value)];
    const words = clean(String(value)).split(/\s+/);
    if (words.length > 2) terms.push(clean(words.slice(0, 2).join(" ")));
    if (words.length > 1) terms.push(clean(words[0]));
    let options = [];
    for (const [round, term] of terms.entries()) {
      if (round > 0) {
        el.focus();
        setNativeValue(el, term);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const budget = round === 0 && isGeocoder ? 175 : 75;   // × 20 ms
      options = suggestionsFor(el);
      for (let i = 0; i < budget && !options.length; i += 1) {
        await sleep(20);
        options = suggestionsFor(el);
      }
      if (options.length) break;
    }

    if (!options.length) {
      return { ok: false, why: listIdsFor(el).length ? "no suggestions appeared" : "no suggestion list found" };
    }

    const chosen = pickOption(options, (o) => o.textContent, value);
    if (!chosen) {
      // The list answered and the answer is not on it. On Fanvue and Espa
      // an organisation-scoped geocoder offered "Netherlands | New Zealand |
      // West" for "Ithaca, NY": the employer restricts locations to where
      // it hires. That is the form's decision about the applicant's value,
      // not a widget the filler could not drive — reported as a mismatch
      // the applicant resolves, with what was offered.
      return {
        ok: false,
        mismatch: true,
        why: `the form's suggestions do not include ${JSON.stringify(value)}; offered: ` +
          options.slice(0, 5).map((o) => o.textContent.trim()).join(" | "),
      };
    }
    const text = chosen.textContent.trim();

    chosen.click();

    // Proof the suggestion was taken, not merely typed: the input reads the
    // suggestion's text AND, where the field is backed by a hidden input
    // (Duolingo writes the chosen id there), that hidden value is set.
    const hidden = el.dataset.firstplayHidden ? document.getElementById(el.dataset.firstplayHidden) : null;
    // Saronic (Ashby, R48-1): the option is three spans — name, country,
    // domain — so its textContent reads "Cornell UniversityUnited
    // Statescornell.edu" while the input shows "Cornell University". The
    // input holding a non-empty prefix of the option's text is the same
    // proof; the input holding something else is not.
    const committed = () => {
      const shown = normalise(el.value);
      const wantedText = normalise(text);
      const same = shown !== "" && (shown === wantedText || wantedText.startsWith(shown));
      return same && (!hidden || hidden.value !== "");
    };
    for (let i = 0; i < 150 && !committed(); i += 1) await sleep(20);

    if (!committed()) {
      return { ok: false, why: hidden && hidden.value === ""
        ? `clicked ${JSON.stringify(text)} but the form did not record a choice`
        : `chose ${JSON.stringify(text)} but the field reads ${JSON.stringify(el.value)}` };
    }

    return { ok: true, chose: text };
  }

  async function fillAutocomplete(el, value) {
    startAutocomplete(el, value);
    return pickAutocomplete(el, value);
  }

  function isReactSelect(el) {
    return el.getAttribute("role") === "combobox" ||
      (el.className || "").includes("select__input");
  }

  /**
   * The react-select component instance behind an input, found by walking the
   * React fiber tree upward until a node whose stateNode has `openMenu`.
   *
   * Reaching into React internals is not a first choice. It is the *only*
   * choice here, and the evidence for that was gathered on a live Greenhouse
   * form rather than assumed: five different synthetic approaches — mousedown
   * on the control, on the input, keydown ArrowDown/Space/Enter, and calling
   * the control's own React onMouseDown through its props — all left
   * aria-expanded="false". So did `instance.openMenu()` and `setState`. The
   * reason is that `menuIsOpen` is a *controlled* prop (false, not undefined):
   * Greenhouse's wrapper owns the open state and re-asserts it on every render,
   * so nothing short of a trusted pointer event opens that menu — and a content
   * script cannot produce one.
   */
  function selectInstanceOf(input) {
    const key = Object.keys(input).find((k) => k.startsWith("__reactFiber"));
    let fiber = key ? input[key] : null;

    for (let hops = 0; fiber && hops < 40; hops += 1, fiber = fiber.return) {
      const node = fiber.stateNode;
      if (node && typeof node.openMenu === "function") return node;
    }

    return null;
  }

  /** Options of a react-select, flattening any grouped options. */
  function instanceOptions(instance) {
    const raw = Array.isArray(instance.props.options) ? instance.props.options : [];

    return raw.flatMap((o) => (Array.isArray(o.options) ? o.options : [o]));
  }

  /** The `loadOptions` of an async react-select, found above the input in the fiber tree. */
  function optionLoaderOf(input) {
    const key = Object.keys(input).find((k) => k.startsWith("__reactFiber"));
    let fiber = key ? input[key] : null;

    for (let hops = 0; fiber && hops < 40; hops += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (typeof props.loadOptions === "function") return props.loadOptions;
    }

    return null;
  }

  /**
   * Options of an async react-select for a search term. Greenhouse's
   * education widgets (school, degree, discipline) load from the board API
   * on demand and keep `props.options` empty until then, so typing into the
   * input from a script shows nothing; calling the loader directly does.
   */
  /**
   * Loader results by control and term. The same school, degree and
   * discipline are looked up on every Greenhouse board, so the terms of the
   * last plan are looked up again as soon as the next board's selects
   * hydrate — before its plan has arrived — and the plan-time prefetch
   * finds the promise already here. General Matter's lookups tier was
   * 863 ms of exactly these calls.
   */
  const lookupCache = new Map();

  function lookupKey(input, term) {
    return `${input.id || input.name || ""}::${normalise(term || "")}`;
  }

  async function loadedOptions(input, term) {
    const loader = optionLoaderOf(input);
    if (!loader) return [];

    const key = lookupKey(input, term);
    if (!lookupCache.has(key)) {
      lookupCache.set(key, (async () => {
        let result;
        try {
          // 3 s, not 8: a loader that hangs held OpenTable's whole lookups
          // tier for 8.7 s. The pick retries the term once more anyway.
          result = await Promise.race([
            Promise.resolve(loader(term, () => {})),
            sleep(3000).then(() => null),
          ]);
        } catch (e) {
          return [];
        }
        const items = Array.isArray(result) ? result : (result && (result.options || result.items)) || [];
        return items.flatMap((o) => (Array.isArray(o.options) ? o.options : [o]));
      })());
    }
    const options = await lookupCache.get(key);
    // An empty result is not worth remembering: the retry path re-asks.
    if (!options.length) lookupCache.delete(key);
    return options;
  }

  /**
   * Start the loader lookups for the terms the last plan used, if this
   * page has the matching controls. Called by the content script as soon as
   * the page has settled, ahead of the plan. Nothing is written; results
   * only wait in `lookupCache`.
   */
  async function warm(terms) {
    const started = [];
    for (const [id, term] of Object.entries(terms || {})) {
      if (!term) continue;
      // Ashby's Location: a remote geocoder that takes 0.4–3.3 s. Typing the
      // stored location as soon as the form renders means its suggestions
      // are already open when the plan arrives and the pick is a click.
      if (id === "_systemfield_location") {
        const container = document.querySelector('[data-field-path="_systemfield_location"]');
        const box = container && container.querySelector('input[role="combobox"], input');
        if (!box || box.value) continue;
        box.focus();
        box.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        setNativeValue(box, term);
        box.dispatchEvent(new Event("input", { bubbles: true }));
        started.push(id);
        continue;
      }
      const el = document.getElementById(id);
      if (!el || !optionLoaderOf(el)) continue;
      started.push(id);
      loadedOptions(el, term).catch(() => {});
    }
    return started;
  }

  /**
   * Options a react-select produces in response to typing — Greenhouse's
   * candidate-location geocoder has no `loadOptions`; it fills
   * `props.options` a few seconds after `onInputChange`. Measured on Scale AI
   * (2026-09-27): focusin + native setter + `input`, then poll the instance.
   */
  async function typedOptions(el, instance, value) {
    el.focus();
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    setNativeValue(el, value);

    // 3 s: FourKites' geocoder was down and the typed lookup waited 9.7 s.
    for (let i = 0; i < 190; i += 1) {
      await sleep(16);
      const fresh = selectInstanceOf(el) || instance;
      const options = instanceOptions(fresh);
      if (options.length) return options;
    }

    return [];
  }

  function optionText(option) {
    return String(option.label !== undefined ? option.label : option.value);
  }

  /**
   * The option a react-select holds, by its own label — not what it displays.
   * The phone-country widget displays "+1" for the option "United States +1";
   * the learning capture read the display, sent "+1" as a correction, and
   * the backend replayed it on every later form (IMC, 2026-10-12).
   */
  function heldOptionText(el) {
    const instance = selectInstanceOf(el);
    if (!instance) return null;
    const state = (instance.state && instance.state.selectValue) || [];
    const value = instance.props && instance.props.value;
    const values = Array.isArray(state) && state.length ? state : (Array.isArray(value) ? value : value ? [value] : []);
    return values.length === 1 && values[0] && typeof values[0] === "object" ? optionText(values[0]) : null;
  }

  /** What a react-select currently displays as its chosen value. */
  function displayedValue(el) {
    const container = el.closest(".select__container") || el.parentElement;
    const single = container && container.querySelector(
      '.select__single-value, [class*="single-value"]'
    );

    return single ? single.textContent.trim() : null;
  }

  /**
   * Choose `value` in a react-select.
   *
   * Selection does not need the menu: `selectOption` is react-select's own
   * method and fires the wrapper's onChange exactly as a click on an option
   * would — verified on a live form, where a synthetic click on an already-open
   * option also worked. Opening the menu is the only thing that resists
   * synthesis, so this path never opens it.
   *
   * The value is read back afterwards. A selection the widget silently
   * rejected must surface as a failure, not as a green outline over a blank.
   */
  /** Options for a react-select, from its props or its loader — the part that can run in parallel. */
  async function reactSelectOptions(el, value) {
    const instance = selectInstanceOf(el);
    if (!instance) return [];
    let options = instanceOptions(instance);
    if (!options.length) options = await loadedOptions(el, value);
    // A typeahead's lookup can come back empty for a moment (Pacific Fusion:
    // the school search returned nothing once, then "Cornell University" on
    // the next call). Retry the term before touching the default page — the
    // default page is the alphabet's start and never holds the answer.
    if (!options.length) { await sleep(300); options = await loadedOptions(el, value); }
    if (!options.length && !optionLoaderOf(el)) options = await loadedOptions(el, "");
    // A typeahead without a loader (the Location geocoder): type now, so the
    // network wait sits in the parallel lookups tier, not in the picks.
    // General Matter's Location took 804 ms inside its pick before this.
    if (!options.length && !optionLoaderOf(el)) options = await typedOptions(el, instance, value);
    return options;
  }

  async function fillReactSelect(el, value, prefetched = null) {
    const instance = selectInstanceOf(el);

    if (!instance) return { ok: false, why: "not a react-select instance" };

    let options = prefetched && prefetched.length ? prefetched : instanceOptions(instance);
    if (!options.length) options = await loadedOptions(el, value);
    if (!options.length) { await sleep(300); options = await loadedOptions(el, value); }
    if (!options.length && optionLoaderOf(el)) {
      return { ok: false, why: `the form's lookup returned nothing for ${JSON.stringify(value)} — try again` };
    }
    if (!options.length) options = await typedOptions(el, instance, value);
    const chosen = pickOption(options, optionText, value);

    if (!chosen) {
      return {
        ok: false,
        why: `no option matching ${JSON.stringify(value)} among ` +
          options.slice(0, 6).map(optionText).join(" | "),
      };
    }

    if (typeof instance.selectOption === "function") {
      instance.selectOption(chosen);
    } else if (typeof instance.props.onChange === "function") {
      instance.props.onChange(chosen, {
        action: "select-option", option: chosen, name: instance.props.name,
      });
    } else {
      return { ok: false, why: "react-select exposes no selection method" };
    }

    return confirmReactSelect(el, instance, chosen);
  }

  /**
   * Wait for a react-select to show or hold the option just selected.
   * Kept separate from the pick for readability; picks are confirmed one at
   * a time on purpose (see the picks tier in applyPlan).
   */
  async function confirmReactSelect(el, instance, chosen) {
    // Readback: what the widget shows, or — when the page is hidden and its
    // rendering lags — what the widget holds. `selectValue` is what react-
    // select submits; the DOM catches up when the tab is visible again.
    const expected = optionText(chosen);
    const held = () => {
      const fresh = selectInstanceOf(el) || instance;
      const state = (fresh.state && fresh.state.selectValue) || [];
      const value = fresh.props && fresh.props.value;
      const values = Array.isArray(state) && state.length ? state : (Array.isArray(value) ? value : value ? [value] : []);
      return values.some((v) => normalise(optionText(v)) === normalise(expected));
    };
    // The phone-country select shows only the dial code ("+1") for the option
    // "United States +1": a display that is a non-empty part of the chosen
    // option's text counts as the option shown.
    const displays = (shownText) => {
      const a = normalise(shownText), b = normalise(expected);
      return !!a && (a === b || (a.length >= 2 && b.includes(a)));
    };
    // Visible: the rendered value is the commit signal — the wrapper owns
    // the value, so the display changes only once the form's state has it.
    // 0.4.24 accepted the widget's held state first, the dry-run submit ran
    // before the form had committed, and every select was flagged required
    // (Pacific Fusion, Rocket Lab, General Matter: false "plan said FILL"
    // rows over correctly filled fields). Hidden: rendering lags, so the
    // held state is the only signal there is.
    // Rendered value first; the held state counts once one frame has passed
    // (or when hidden, where nothing renders). Some widgets never expose a
    // readable display — Lightmatter's gender select ran the whole 2 s wait
    // before the held state was consulted.
    // A tab covered mid-fill renders nothing, so the display never changes;
    // Rocket Lab spent 25.6 s in picks that way (thirteen selects, 2 s cap
    // each). Hidden, the wait is short and the held state decides.
    let frames = 0;
    const settled = () => displays(shown) || (held() && (document.hidden || frames >= 1));
    const cap = () => (document.hidden ? 12 : 120);
    let shown = displayedValue(el);
    await Promise.resolve();
    for (; frames < cap() && !settled(); frames += 1) {
      await sleep(16);
      shown = displayedValue(el);
    }

    if (!displays(shown) && !held()) {
      return { ok: false, why: `selected ${JSON.stringify(expected)} but widget shows ` +
        JSON.stringify(shown) };
    }

    return { ok: true, chose: expected };
  }

  /** Tick the checkbox or radio whose label matches `value`. */
  /** The inputs that together form one choice question. */
  function choiceCandidates(el) {
    const prefix = ((el.id || "").match(/^(.*-labeled-(?:checkbox|radio))-\d+$/) || [])[1];
    if (prefix) return Array.from(document.querySelectorAll(`[id^="${CSS.escape(prefix)}-"]`));
    if (el.name) return Array.from(document.querySelectorAll(`[name="${CSS.escape(el.name)}"]`));
    return [el];
  }

  function fillChoiceInput(el, value) {
    const wanted = normalise(value);
    const candidates = choiceCandidates(el);

    // A lone checkbox is a yes/no question: "Yes" ticks it, "No" leaves it
    // clear. Its label is the question, so matching option text would never
    // hit. Measured on Ashby: "Are you authorized to work lawfully…" is one
    // checkbox in its own container.
    if (candidates.length === 1 && (el.type || "").toLowerCase() === "checkbox") {
      // OpenAI (Ashby, R49): "I hereby certify that I have read…" is a
      // one-option select in the API and a single checkbox on the page; the
      // plan's value is that option's own label ("I confirm I have read the
      // above."). The label of the box *is* the yes.
      const ownLabel = (() => {
        const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        const label = byFor || el.closest("label");
        return label ? normalise(label.innerText) : "";
      })();
      const yes = /^(yes|true|y)$/.test(wanted) || (ownLabel !== "" && wanted === ownLabel);
      const no = /^(no|false|n)$/.test(wanted);
      if (!yes && !no) return { ok: false, why: `${JSON.stringify(value)} is not yes/no` };
      if (el.checked !== yes) el.click();
      // Read back. A controlled box the page's state refused snaps back as
      // the click's handler returns; a "Yes" that is not checked is not a
      // fill, whatever was clicked. A "No" over a box already clear is one.
      if (el.checked !== yes) {
        return { ok: false, why: yes ? "clicked the box but it did not stay checked" : "clicked the box but it did not clear" };
      }
      return { ok: true, chose: yes ? "Yes" : "No" };
    }

    const textOf = (candidate) => {
      const label = candidate.id
        ? document.querySelector(`label[for="${CSS.escape(candidate.id)}"]`)
        : candidate.closest("label");
      return label ? label.innerText : candidate.value;
    };
    const chosen = pickOption(candidates, textOf, value);
    if (chosen) {
      // A click on a checked checkbox clears it, so one already holding the
      // answer is left alone; and the answer counts only once it reads checked.
      if (!chosen.checked) chosen.click();
      if (!chosen.checked) return { ok: false, why: "clicked the option but it did not register as chosen" };
      return { ok: true, chose: textOf(chosen).trim() };
    }

    return { ok: false, why: `no option is exactly ${JSON.stringify(value)}` };
  }

  function outline(el, style, title) {
    const target = el.closest(".select__control") || el;
    target.style.outline = style;
    target.style.outlineOffset = "1px";
    if (title) target.title = title;
  }

  /**
   * A visible note beside a field whose answer is known but could not be
   * written. An amber outline and a console row were not enough: on a live
   * Duolingo form the table said FILL, the field stayed empty, and the whole
   * extension looked broken. The applicant should see the value to pick.
   */
  function badge(el, text) {
    const anchor = el.closest('[role="group"]') || el.closest(".select__container") || el;
    const existing = anchor.parentElement && anchor.parentElement.querySelector(".firstplay-badge");
    if (existing) existing.remove();

    const note = document.createElement("div");
    note.className = "firstplay-badge";
    note.textContent = text;
    note.style.cssText =
      "margin:4px 0 8px;padding:4px 8px;font:12px/1.4 system-ui,sans-serif;" +
      "color:#7c2d12;background:#ffedd5;border:1px solid #fdba74;border-radius:4px;";
    anchor.insertAdjacentElement("afterend", note);
  }

  /**
   * Apply a plan to the page.
   *
   * Never touches a submit control, and never fills a field the plan did not
   * mark as fillable.
   *
   * @returns {Promise<object>} counts and per-field outcomes
   */
  /**
   * A dropdown built from a button and a listbox — neither a <select> nor a
   * react-select. Measured on Duolingo's careers site (2026-09-27): the plan's
   * field id sits on a <div role="group"> whose <button aria-haspopup="listbox"
   * aria-controls=ID> opens #ID full of <li role="option">. A synthetic click
   * opens it, clicking an option closes it, and the chosen text then appears
   * inside the group; nothing else on the page holds the value, so that text
   * is the readback.
   */
  async function fillListbox(el, value, extraValues = []) {
    const button = el.matches('button[aria-haspopup="listbox"]')
      ? el
      : el.querySelector('button[aria-haspopup="listbox"]');
    // Readback is the text of the group the button sits in, which is where
    // the chosen value is shown when the plan id was on the group itself or
    // on a hidden input beside the button.
    const shown = () => normalise((button && button.closest('[role="group"]') || el).textContent);

    if (!button) return { ok: false, why: `not a form control (<${el.tagName.toLowerCase()}>)` };

    // Clicking the already-selected option *deselects* it on this widget
    // (measured: "No" -> "Select..."), so a field that already shows the
    // wanted value is left alone rather than re-clicked.
    const wanted = normalise(value);
    if (!extraValues.length && shown() === wanted) return { ok: true, chose: value };

    button.click();

    // The page's main thread can be slow (a 300 ms timer took 1 s on Duolingo),
    // so the list is polled for well past the time it needs when idle.
    let list = null;
    for (let i = 0; i < 40 && !list; i += 1) {
      await sleep(40);
      const id = button.getAttribute("aria-controls");
      list = (id && document.getElementById(id)) || null;
    }

    const options = list ? Array.from(list.querySelectorAll('[role="option"]')) : [];
    if (!options.length) return { ok: false, why: "listbox did not open" };

    const chosen = pickOption(options, (o) => o.textContent, value);

    if (!chosen) {
      button.click();
      return {
        ok: false,
        why: `no option matching ${JSON.stringify(value)} among ` +
          options.slice(0, 6).map((o) => o.textContent.trim()).join(" | "),
      };
    }

    // Multi-select lists (aria-multiselectable, measured on Duolingo's
    // self-identification block) stay open after each click; a click on an
    // already-selected option deselects it, so those are skipped.
    const picks = [chosen].concat(
      extraValues.map((v) => options.find((o) => normalise(o.textContent) === normalise(v)))
        .filter(Boolean)
    );
    const chosenText = picks.map((o) => o.textContent.trim());
    for (const pick of picks) {
      if (pick.getAttribute("aria-selected") !== "true") pick.click();
      await sleep(40);
    }
    if (document.getElementById(button.getAttribute("aria-controls") || "")) button.click();
    for (let i = 0; i < 20 && !chosenText.every((t) => shown().includes(normalise(t))); i += 1) await sleep(40);

    const missing = chosenText.filter((t) => !shown().includes(normalise(t)));
    if (missing.length) {
      return {
        ok: false,
        why: `chose ${JSON.stringify(chosenText.join(", "))} but the field shows ` +
          JSON.stringify((button.closest('[role="group"]') || el).textContent.trim().slice(0, 40)),
      };
    }

    return { ok: true, chose: chosenText.join(", ") };
  }

  /** Write one value into one located control, whatever kind it is. */
  async function fillControl(el, entry, value) {
    let result;

    const extras = entry.values.length > 1 ? entry.values.slice(1) : [];

    // A fieldset of radios or checkboxes (Greenhouse renders "How did you
    // hear about us?" this way on some boards): choose among its inputs.
    if (el.tagName === "FIELDSET" || el.hasAttribute("data-field-path")) {
      // Ashby's Boolean field is two buttons ("Yes" / "No") that toggle
      // aria-pressed, with a hidden checkbox behind them. Held-out round
      // R48-1 (2026-10-01): on Crusoe, Fab and Exegy a "No" was reported
      // filled while neither button was pressed — the lone-checkbox rule
      // below had "left it unchecked" and called that an answer. Press the
      // button the value names, and believe it only when it reads pressed.
      const yesNo = el.querySelector(".ashby-application-form-input-yesno, [class*='input-yesno']");
      if (yesNo) {
        const wanted = normalise(value);
        const option = /^(yes|true|y)$/.test(wanted) ? "yes" : /^(no|false|n)$/.test(wanted) ? "no" : null;
        if (!option) return { ok: false, why: `${JSON.stringify(value)} is not yes/no` };
        const button = yesNo.querySelector(`button[data-option="${option}"]`) ||
          Array.from(yesNo.querySelectorAll("button")).find((b) => normalise(b.textContent) === option);
        if (!button) return { ok: false, why: `no ${option} button in the yes/no control` };
        if (button.getAttribute("aria-pressed") !== "true") button.click();
        for (let i = 0; i < 25 && button.getAttribute("aria-pressed") !== "true"; i += 1) await sleep(20);
        const pressed = button.getAttribute("aria-pressed") === "true";
        return pressed ? { ok: true, chose: button.textContent.trim() }
                       : { ok: false, why: `clicked ${option} but the button did not register as pressed` };
      }
      const candidates = Array.from(el.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      // A lone checkbox in an Ashby container is a yes/no question.
      if (candidates.length === 1 && candidates[0].type === "checkbox") return fillChoiceInput(candidates[0], value);
      if (!candidates.length) return { ok: false, why: "fieldset holds no choices" };
      const textOf = (c) => { const l = c.id ? document.querySelector(`label[for="${CSS.escape(c.id)}"]`) : c.closest("label"); return l ? l.innerText : c.value; };
      const chosen = pickOption(candidates, textOf, value);
      if (!chosen) return { ok: false, why: `no choice is exactly ${JSON.stringify(value)}; offered: ` + candidates.slice(0, 6).map((c) => textOf(c).trim()).join(" | ") };
      if (!chosen.checked) chosen.click();
      for (const extra of extras) { const more = pickOption(candidates, textOf, extra); if (more && !more.checked) more.click(); }
      return { ok: chosen.checked, chose: textOf(chosen).trim() };
    }

    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
        el.matches('button[aria-haspopup="listbox"]')) {
      result = await fillListbox(el, value, extras);
      return result;
    } else if (isReactSelect(el) && selectInstanceOf(el)) {
      result = await fillReactSelect(el, value);
    } else if (el.getAttribute("role") === "combobox" ||
               (el.tagName === "INPUT" && el.getAttribute("aria-haspopup") === "listbox") ||
               el.dataset.firstplayAutocomplete === "1") {
      result = await fillAutocomplete(el, value);
    } else if (["checkbox", "radio"].includes((el.type || "").toLowerCase())) {
      result = fillChoiceInput(el, value);
    } else if (el.tagName === "SELECT") {
      const option = Array.from(el.options)
        .find((o) => normalise(o.textContent) === normalise(value));
      if (option) {
        el.value = option.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // Read back: a controlled <select> the page re-renders over keeps
        // its old selectedIndex, and the change event alone proved nothing.
        const check = () => {
          const selected = el.options[el.selectedIndex];
          return selected && el.value === option.value && normalise(selected.textContent) === normalise(option.textContent)
            ? { ok: true, chose: option.textContent.trim() }
            : { ok: false, why: "the menu did not keep the choice" };
        };
        result = { ...check(), verify: check };
      } else {
        result = { ok: false, why: "no matching option" };
      }
    } else if ((el.type || "").toLowerCase() === "number") {
      // R48-2: TELUS "Phone" and Atominvest "notice period (in months)" are
      // <input type=number>; a dashed phone and "8 weeks +" left them empty
      // while the fill reported success. A phone becomes its digits; any
      // other non-numeric value is refused here rather than silently dropped.
      const digits = String(value).replace(/\D/g, "");
      const numeric = /^\s*-?\d+([.,]\d+)?\s*$/.test(String(value));
      const asNumber = numeric ? String(value).trim().replace(",", ".") : (digits.length >= 7 ? digits : null);
      if (asNumber === null) {
        result = { ok: false, why: `this field takes a number; ${JSON.stringify(String(value).slice(0, 30))} is not one` };
      } else {
        setNativeValue(el, asNumber);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const check = () => ((el.value || "") !== "" ? { ok: true, chose: asNumber }
                                                     : { ok: false, why: `the number input rejected ${JSON.stringify(asNumber)}` });
        result = { ...check(), verify: check };
      }
    } else {
      setNativeValue(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Read back, and again a frame later (the instant tier re-asks every
      // `verify` after one frame before recording): a controlled input whose
      // state the page did not take re-renders empty, a mask reformats a
      // phone, a date input rejects anything but ISO. Reported ok without
      // looking until 0.4.51 — R48-2's two "filled yet still wanted" text
      // fields were this path (audit M4).
      const check = () => (textHolds(el.value, value, el.type)
        ? { ok: true, chose: value }
        : { ok: false, why: (el.value || "") === "" ? "wrote it but the field reads empty"
                                                    : "wrote it but the field now reads something else" });
      result = { ...check(), verify: check };
    }

    // Multi-select: tick the rest too. On react-select this only makes sense
    // when the widget is isMulti — a second selectOption on a single-select
    // would replace the first choice rather than add to it.
    if (result.ok && entry.values.length > 1) {
      const instance = isReactSelect(el) ? selectInstanceOf(el) : null;
      const canAdd = !isReactSelect(el) || (instance && instance.props.isMulti);
      if (canAdd) {
        for (const extra of entry.values.slice(1)) {
          if (isReactSelect(el)) await fillReactSelect(el, extra);
          else fillChoiceInput(el, extra);
        }
      }
    }

    return result;
  }

  /**
   * Put a stored document into a file input.
   *
   * A script cannot set a *path* on a file input, but it can build a File
   * from bytes and assign a DataTransfer's files. Measured on Scale AI's
   * resume input (2026-09-27): the page showed the filename and fired its own
   * presigned S3 upload — indistinguishable from a manual attach. The bytes
   * come from the extension's local storage, where the applicant put them
   * once through the popup; nothing leaves the browser except to the form.
   */
  function fillFile(el, doc) {
    const bytes = Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0));
    const file = new File([bytes], doc.name, { type: doc.type || "application/octet-stream" });
    const transfer = new DataTransfer();
    transfer.items.add(file);

    try {
      el.files = transfer.files;
    } catch (e) {
      return { ok: false, why: `file input refused the file: ${e.message}` };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    if (!el.files.length || el.files[0].name !== doc.name) {
      return { ok: false, why: "file input did not keep the file" };
    }
    return { ok: true, chose: doc.name };
  }

  /**
   * Apply a plan to the page.
   *
   * @param {object} plan  the backend's FillPlan
   * @param {object} [context]  `{ resume }` — the stored resume document, if any
   */
  /** Which driver a located control needs — decides its tier below. */
  /** react-select by its markup alone — the fiber may not be attached yet. */
  function looksLikeReactSelect(el) {
    return (el.className || "").includes("select__input") ||
      /^react-select-/.test(el.id || "") ||
      !!el.closest(".select__container, .select__control, [class*='select__value-container']");
  }

  /**
   * Wait for React to own a control. The plan now arrives before the page
   * has finished hydrating (the request goes out at first sight of the
   * posting), and on Coinbase the standard selects were driven before
   * `__reactFiber` existed: they fell through to the autocomplete path and
   * were offered the phone widget's country list. Bounded at 3 s.
   */
  async function hydrated(el) {
    // Bounded at 20 s, returning at once when the instance exists (the
    // foreground case). In a hidden tab Greenhouse does not hydrate at all
    // (NISC: 0 of 12 selects owned by React minutes after load), so a fill
    // there reports the selects as not enterable rather than guessing.
    // The budget counts only while the page is visible: Greenhouse pauses
    // hydration when the tab is hidden, and a tab that flickered visible for
    // a moment (Lightmatter, round 5) must not burn its 20 s in the dark.
    let spent = 0;
    while (spent < 1000) {
      if (selectInstanceOf(el)) return true;
      if (document.hidden) {
        await new Promise((resolve) => {
          const onShow = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", onShow); resolve(); } };
          document.addEventListener("visibilitychange", onShow);
        });
        continue;
      }
      await sleep(20);
      spent += 1;
    }
    return false;
  }

  function widgetKind(el) {
    if ((el.tagName === "FIELDSET" || el.hasAttribute("data-field-path")) && el.querySelector('input[type="radio"], input[type="checkbox"]')) return "instant";
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.matches('button[aria-haspopup="listbox"]')) return "listbox";
    if ((isReactSelect(el) && selectInstanceOf(el)) || looksLikeReactSelect(el)) return "react-select";
    if (el.getAttribute("role") === "combobox" ||
        (el.tagName === "INPUT" && el.getAttribute("aria-haspopup") === "listbox") ||
        el.dataset.firstplayAutocomplete === "1") return "autocomplete";
    return "instant";
  }

  /**
   * Apply a plan to the page — in tiers, so waits overlap instead of adding up.
   *
   *   instant       text, checkboxes, radios, native selects, the résumé: no waits
   *   react-select  every option lookup (network) fires at once; picks are synchronous
   *   autocomplete  every search is started first; then each list is picked from
   *   listbox       local menus, one after another (opening one may close another)
   *
   * Measured before this: education on the standard renderer paid three
   * sequential network lookups; on Duolingo, the school search and the
   * location geocoder waited one after the other. Widgets that need focus are
   * never driven concurrently; only their lookups are.
   *
   * @param {object} plan  the backend's FillPlan
   * @param {object} [context]  `{ resume }` — the stored resume document, if any
   */
  /**
   * The answer a plan entry carries for the Hispanic/Latino question, or null
   * when there is none to write: no entry (an older backend), needs_review,
   * skipped, a sibling's, or empty. Nothing is derived from any other answer.
   */
  function hispanicAnswerFrom(entry) {
    if (!entry || entry.needs_review || entry.skipped || entry.satisfied_by) return null;
    const value = entry.values && entry.values.length ? entry.values[0] : entry.value;
    if (value === null || value === undefined || String(value).trim() === "") return null;
    return String(value);
  }

  const HISPANIC_LABEL = "Are you Hispanic or Latino?";
  const NEVER_INFERRED = "answer this yourself; FirstPlay never infers ethnicity";

  /**
   * Greenhouse's two-question EEO block. The API lists one compliance field,
   * `race`, but 7 of 9 surveyed boards render `hispanic_ethnicity` (Yes / No
   * / Decline) first and mount `race` only after it is answered.
   *
   * The Hispanic answer is the applicant's own stored answer to that exact
   * question, carried by the plan as its `hispanic_ethnicity` entry. Until
   * 0.4.51 it was derived from the stored race by substring — Ashby's own
   * wording "White (Not Hispanic or Latino)" read as Yes, a stored "I don't
   * wish to answer" read as No (audit H1). Nothing is inferred now: without
   * a usable entry the question is outlined for the applicant and `race`
   * stays unmounted; the caller counts both as review.
   *
   * Returns { state, el, why }: "absent" when the page has no such block (or
   * already shows `race`, so the main loop handles both by id), "filled"
   * with the `race` control once it mounts, "review" when the question was
   * left, "failed" when the widget refused the stored answer.
   */
  async function revealRace(hispanicEntry) {
    const hispanic = document.getElementById("hispanic_ethnicity");
    if (!hispanic || document.getElementById("race")) return { state: "absent", el: document.getElementById("race") };

    const answer = hispanicAnswerFrom(hispanicEntry);
    if (answer === null) {
      const why = (hispanicEntry && hispanicEntry.reason) || NEVER_INFERRED;
      outline(hispanic, OUTLINE_REVIEW, `FirstPlay: needs you — ${why}`);
      return { state: "review", el: null, why };
    }

    await hydrated(hispanic);
    const result = await fillReactSelect(hispanic, answer);
    if (!result.ok) {
      outline(hispanic, OUTLINE_REVIEW, `FirstPlay: could not fill — ${result.why}`);
      return { state: "failed", el: null, why: result.why };
    }
    outline(hispanic, OUTLINE_FILLED, `FirstPlay: ${hispanicEntry.reason || hispanicEntry.source || "your stored answer"}`);

    for (let i = 0; i < 100 && !document.getElementById("race"); i += 1) await sleep(20);
    return { state: "filled", el: document.getElementById("race") };
  }

  /**
   * One row of the run record's `fields`: what the plan said about a field
   * (key, label, source, confidence) and what happened to it — never the
   * value. Quoted strings inside a reason are the values the widget messages
   * quote, so they are blanked. This is what lets precision be audited from
   * survey rows: a model-decided fill and a replay were indistinguishable
   * there before (audit M4).
   */
  function fieldRecord(entry, state, ok, why) {
    const e = entry || {};
    const row = {
      key: String(e.field_key || "").slice(0, 80),
      label: String(e.label || "").slice(0, 60),
      source: e.source || null,
      confidence: typeof e.confidence === "number" ? Math.round(e.confidence * 100) / 100 : null,
      state,
      ok: !!ok,
    };
    if (why) row.why = String(why).replace(/"(?:[^"\\]|\\.)*"/g, '"…"').slice(0, 80);
    return row;
  }

  /** One frame for the form to commit the last write before anyone reads it (a hidden tab has no frames). */
  function frame() {
    if (document.hidden) return sleep(32);
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  /**
   * Do not write into a form React has not taken over yet. Greenhouse's
   * standard form hydrates lazily and not at all while its tab is hidden;
   * a fill that lands first is wiped when hydration re-renders (Schonfeld,
   * round 3: 9 green outlines, then none). So: if the tab is hidden, wait
   * for it to be shown — postings opened in background tabs fill the moment
   * they are looked at — and then wait for the selects to be owned.
   */
  async function pageReady() {
    // Only a page with react-selects has anything to wait for while hidden
    // (Greenhouse's hydration); Ashby's plain controls are written as they are.
    const hasReactSelects = document.querySelector(".select__input") !== null;
    if (document.hidden && hasReactSelects) {
      await new Promise((resolve) => {
        const onShow = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", onShow); resolve(); } };
        document.addEventListener("visibilitychange", onShow);
      });
    }
    const selects = document.querySelectorAll(".select__input");
    if (selects.length) await hydrated(selects[selects.length - 1]);
  }

  async function applyPlan(plan, context = {}) {
    const outcome = { filled: 0, attach: 0, review: 0, failed: 0, missing: 0, details: [], fields: [], timing: {}, slow: [] };
    const note = (entry, state, ok, why) => outcome.fields.push(fieldRecord(entry, state, ok, why));
    const work = { instant: [], "react-select": [], autocomplete: [], listbox: [] };

    // Where the fill's time goes, per tier, and the slowest controls: the
    // applicant's target is a fill under one second, and a number per tier is
    // the only way to know which tier is over it.
    const t0 = performance.now();
    let tMark = t0;
    const lap = (name) => { const now = performance.now(); outcome.timing[name] = Math.round(now - tMark); tMark = now; };
    let phase = "instant";
    const timed = async (item, fn) => {
      const started = performance.now();
      const result = await fn();
      const ms = Math.round(performance.now() - started);
      if (ms >= 300) outcome.slow.push({ label: (item.entry.label || item.entry.field_key || "").slice(0, 50), kind: `${widgetKind(item.el)} ${phase}`, ms });
      return result;
    };

    await pageReady();
    lap("ready");
    phase = "instant";

    // The Greenhouse EEO block first: `race` mounts only once the Hispanic
    // question is answered, and only the plan's own `hispanic_ethnicity`
    // entry may answer it. When it does not, both questions are the
    // applicant's and both count as review.
    const hispanicEntry = plan.entries.find((e) => e.field_key === "hispanic_ethnicity") || null;
    const eeo = await revealRace(hispanicEntry);
    const eeoEntry = hispanicEntry || { field_key: "hispanic_ethnicity", label: HISPANIC_LABEL, source: null };
    if (eeo.state === "filled") {
      outcome.filled += 1;
      note(hispanicEntry, "filled", true);
    } else if (eeo.state === "review") {
      outcome.review += 1;
      outcome.details.push({ label: HISPANIC_LABEL, state: "needs you", why: eeo.why });
      note(eeoEntry, "review", false, eeo.why);
    } else if (eeo.state === "failed") {
      outcome.failed += 1;
      outcome.details.push({ label: HISPANIC_LABEL, state: "failed", why: eeo.why });
      note(eeoEntry, "failed", false, eeo.why);
    }

    for (const entry of plan.entries) {
      if (eeo.state !== "absent" && entry.field_key === "hispanic_ethnicity") continue;
      if (eeo.state !== "absent" && eeo.state !== "filled" && entry.field_key === "race" && !entry.skipped && !entry.satisfied_by) {
        const why = "shown once the Hispanic/Latino question above is answered — yours to answer";
        outcome.review += 1;
        outcome.details.push({ label: entry.label, state: "needs you", why });
        note(entry, "review", false, why);
        continue;
      }

      const found = locateWithReason(entry);
      const el = found.el;

      if (!el) {
        if (entry.skipped || entry.satisfied_by) continue;
        // Two controls under one label: the answer is known and the page
        // would not take it unambiguously, so it is a miss, with the reason.
        if (found.why) {
          outcome.failed += 1;
          outcome.details.push({ label: entry.label, state: "failed", why: found.why });
          note(entry, "failed", false, found.why);
          continue;
        }
        // Expected for a sibling control the page does not render — Greenhouse
        // offers a resume textarea in its API that Figma's form omits.
        outcome.missing += 1;
        outcome.details.push({ label: entry.label, state: "not on page" });
        note(entry, "missing", false);
        continue;
      }

      const wantsReview = entry.needs_review || (entry.value === null && !entry.values.length);

      // Skipped by a standing decision, or answered by a sibling / made
      // inapplicable by an earlier answer: nothing is written. A sibling entry
      // can still carry a leftover value — on Duolingo "If so, are you
      // eligible for OPT?" carried "Yes" from the work-authorisation theme and
      // was written in green while the plan said "not applicable".
      if (entry.skipped || entry.satisfied_by) continue;

      if ((el.type || "").toLowerCase() === "file") {
        // What this slot asks for is the plan's decision (entry.document:
        // resume, cover_letter, transcript, portfolio, other), with a label
        // read as the fallback for an older backend. A slot takes the stored
        // document of its own kind or nothing — the résumé went into "Please
        // provide a recent transcript of your undergraduate studies" before
        // 0.4.48, which was a wrong document under the applicant's name.
        const kind = entry.document ||
          (/transcript|academic record/i.test(`${entry.label || ""} ${entry.value || ""}`) ? "transcript"
            : /cover letter/i.test(entry.label || "") ? "cover_letter"
            : /portfolio|sample/i.test(entry.label || "") ? "portfolio"
            : /resume|résumé|\bcv\b/i.test(`${entry.label || ""} ${entry.field_key || ""}`) ? "resume" : "other");
        const doc = kind === "resume" ? context.resume : kind === "transcript" ? context.transcript : null;
        const docName = kind.replace("_", " ");
        if (doc) {
          const attached = fillFile(el, doc);
          if (attached.ok) {
            outline(el, OUTLINE_FILLED, `FirstPlay: attached ${attached.chose}`);
            outcome.filled += 1;
            outcome.details.push({ label: entry.label, state: "attached", value: attached.chose });
            note(entry, "attached", true);
            continue;
          }
          outcome.details.push({ label: entry.label, state: "failed", why: attached.why });
        }
        // No stored document of that kind (or the input refused it): say what
        // to drag in, and say when the form requires it.
        const req = entry.required ? " (required)" : "";
        outline(el, OUTLINE_ATTACH, `FirstPlay: attach your ${docName}${req}`);
        badge(el, kind === "resume" || kind === "transcript"
          ? `FirstPlay: attach your ${docName} here${req} — or upload it once in the extension popup and it will be attached for you next time.`
          : `FirstPlay: this asks for a ${docName}${req} — attach it by hand.`);
        outcome.attach += 1;
        outcome.details.push({ label: entry.label, state: "attach by hand",
                               value: entry.value });
        note(entry, "attach", false, `attach your ${docName} by hand`);
        continue;
      }

      if (wantsReview) {
        outline(el, OUTLINE_REVIEW,
                `FirstPlay: needs you — ${entry.reason || "no stored answer"}`);
        outcome.review += 1;
        note(entry, "review", false, entry.reason || "no stored answer");
        continue;
      }

      const value = entry.values.length ? entry.values[0] : entry.value;
      work[widgetKind(el)].push({ entry, el, value });
    }

    const record = (item, written) => {
      const { entry, el, value } = item;
      // A writer that reads back later hands over `verify`; asked now.
      let result = written || { ok: false, why: "no result" };
      if (typeof result.verify === "function") {
        try { result = result.verify(); } catch (e) { result = { ok: false, why: `read-back threw ${e && e.message}` }; }
      }
      if (result.ok) {
        outline(el, OUTLINE_FILLED, `FirstPlay: ${entry.reason || entry.source}`);
        outcome.filled += 1;
        note(entry, "filled", true);
      } else if (result.mismatch) {
        // The widget worked; the form's own answer set excludes the value.
        outline(el, OUTLINE_REVIEW, `FirstPlay: needs you — ${result.why}`);
        try { badge(el, `FirstPlay: your answer ${JSON.stringify(value)} is not among this form's choices — ${result.why}`); } catch (e) { /* ignore */ }
        outcome.review += 1;
        outcome.details.push({ label: entry.label, state: "mismatch", why: result.why, value });
        note(entry, "mismatch", false, result.why);
      } else {
        outline(el, OUTLINE_REVIEW, `FirstPlay: could not fill — ${result.why}`);
        // Drawing the note must never abort the run.
        try { badge(el, `FirstPlay knows this one: ${value} — please pick it (${result.why})`); } catch (e) { /* ignore */ }
        outcome.failed += 1;
        outcome.details.push({ label: entry.label, state: "failed", why: result.why, value });
        note(entry, "failed", false, result.why);
      }
    };
    // One control that throws must not stop the rest of the form (seen on
    // Duolingo: the plan's id landed on a <div>, the setter threw, and every
    // later field went unfilled).
    const guarded = async (fn) => {
      try { return await fn(); } catch (e) { return { ok: false, why: `threw ${e && e.message}` }; }
    };

    // Tier 1: instant. Written in one pass; the text, number and native-
    // select writers hand back a `verify`, asked once one frame has passed so
    // a controlled input the page re-rendered over is seen empty rather than
    // as it stood in the write's own tick. One frame for the tier, not one
    // per field.
    const written = [];
    for (const item of work.instant) written.push([item, await timed(item, () => guarded(() => fillControl(item.el, item.entry, item.value)))]);
    if (written.some(([, r]) => r && typeof r.verify === "function")) await frame();
    for (const [item, result] of written) record(item, result);
    lap("instant");
    phase = "lookup";

    // Tier 2: all react-select lookups at once, then synchronous picks —
    // after React owns the controls.
    if (work["react-select"].length) await hydrated(work["react-select"][0].el);
    let typedChain = Promise.resolve();
    const prefetched = await Promise.all(
      work["react-select"].map((item) => {
        const typed = selectInstanceOf(item.el) && !instanceOptions(selectInstanceOf(item.el)).length && !optionLoaderOf(item.el);
        const run = () => timed(item, () => guarded(() => reactSelectOptions(item.el, item.value))).then((r) => (Array.isArray(r) ? r : []));
        if (!typed) return run();
        // Typeaheads take focus, so they run one after another — but
        // alongside every loader lookup.
        const next = typedChain.then(run);
        typedChain = next.catch(() => []);
        return next;
      })
    );

    // Tier 3: start every autocomplete search before picking from any.
    for (const item of work.autocomplete) {
      try { startAutocomplete(item.el, item.value); } catch (e) { /* recorded by the pick below */ }
    }

    lap("lookups");
    phase = "pick";
    // One pick per frame, never two in one tick. Greenhouse's wrapper folds
    // each change into the form's state from a closure over the previous
    // state: two picks fired in the same tick both *display* (the widgets
    // hold their own value) but the form keeps only the last — measured on
    // Lightmatter with a dry-run submit after each variant (DECISIONS §44).
    // 0.4.23 fired every pick at once and the oracle flagged the losers as
    // "required" over green outlines. A pick confirms on its rendered value,
    // or on its held state once a frame has passed; the poll is 16 ms, so
    // thirteen selects cost about a quarter of a second, not 581 ms.
    for (const [i, item] of work["react-select"].entries()) {
      if (!selectInstanceOf(item.el)) await hydrated(item.el);
      record(item, await timed(item, () => guarded(() => fillReactSelect(item.el, item.value, prefetched[i]))));
      if (item.entry.values.length > 1) await guarded(() => fillControl(item.el, item.entry, item.value));
    }
    // One frame for the form to commit the last pick before anyone reads it.
    await frame();
    lap("picks");
    for (const item of work.autocomplete) record(item, await timed(item, () => guarded(() => pickAutocomplete(item.el, item.value))));
    lap("autocomplete");
    for (const item of work.listbox) record(item, await timed(item, () => guarded(() => fillControl(item.el, item.entry, item.value))));
    lap("listbox");
    outcome.timing.total = Math.round(performance.now() - t0);
    outcome.slow.sort((a, b) => b.ms - a.ms);
    outcome.slow = outcome.slow.slice(0, 5);

    return outcome;
  }

  ns.applyPlan = applyPlan;
  ns.warm = warm;
  ns.fillFile = fillFile;
  ns.selectInstanceOf = selectInstanceOf;
  ns.displayedValue = displayedValue;
  ns.heldOptionText = heldOptionText;
  ns.locate = locate;
  ns.locateWithReason = locateWithReason;
  ns.setNativeValue = setNativeValue;
  ns.fillReactSelect = fillReactSelect;
  // Pure pieces, for the node tests.
  ns._fill = { normalise, pickOption, textHolds, hispanicAnswerFrom, fieldRecord, locateWithReason };
})(FirstPlay);
