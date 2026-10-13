// node tests/extract.test.mjs — which pages are an application (audit F3):
// exact ATS hosts, the embed frame, and a non-ATS page that is described
// but never detected as a posting. The worker's matcher (config.js) must
// agree with the content script's (extract.js) on every vector. No browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { atsOfHost as workerAtsOfHost, atsOfUrl } from "../src/config.js";

const src = readFileSync(new URL("../src/extract.js", import.meta.url), "utf8");

function page(host, pathname, search = "", { embedFor = null, iframeSrc = null } = {}) {
  const doc = {
    querySelector: (sel) => sel.includes("greenhouse.io/embed/job_board") && embedFor
      ? { src: `https://boards.greenhouse.io/embed/job_board/js?for=${embedFor}` } : null,
    querySelectorAll: (sel) => sel.startsWith("iframe") && iframeSrc ? [{ getAttribute: () => iframeSrc }] : [],
    getElementById: () => null,
  };
  const sandbox = { document: doc, window: { location: { host, pathname, search, href: `https://${host}${pathname}${search}` } },
    URLSearchParams, URL, CSS: { escape: (s) => s } };
  vm.runInNewContext(src, sandbox);
  return sandbox.FirstPlay;
}
const detect = (...a) => page(...a).detectPosting();
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// --- p02's three detections are rejected
assert.equal(detect("evilgreenhouse.io", "/acme/jobs/4000000"), null, "a host that merely ends with greenhouse.io");
assert.equal(detect("notashbyhq.com", "/acme/00000000-0000-0000-0000-000000000000"), null, "… or with ashbyhq.com");
assert.equal(detect("evil.example.com", "/jobs", "?gh_jid=4000000", { embedFor: "acme" }), null, "gh_jid plus an embed script on a foreign host is not a posting");
assert.equal(detect("greenhouse.io", "/acme/jobs/1"), null, "the apex alone is not an application host");
assert.equal(detect("jobs.ashbyhq.com.evil.example", "/acme/00000000-0000-0000-0000-000000000000"), null);
assert.equal(detect("boards.greenhouse.io.evil.example", "/embed/job_app", "?for=acme&token=1"), null);

// --- the legitimate hosts are accepted
same(detect("job-boards.greenhouse.io", "/acme/jobs/4000000"), { ats: "greenhouse", board: "acme", jobId: "4000000" });
same(detect("boards.greenhouse.io", "/acme/jobs/4000000"), { ats: "greenhouse", board: "acme", jobId: "4000000" });
same(detect("job-boards.eu.greenhouse.io", "/acme/jobs/4000000"), { ats: "greenhouse", board: "acme", jobId: "4000000" }, "EU boards are proper subdomains");
same(detect("boards.greenhouse.io", "/embed/job_app", "?for=acme&token=4000000"),
  { ats: "greenhouse", board: "acme", jobId: "4000000", embedded: true }, "the embed frame, seen from inside");
same(detect("boards.eu.greenhouse.io", "/embed/job_app", "?for=acme&token=4000000"),
  { ats: "greenhouse", board: "acme", jobId: "4000000", embedded: true });
same(detect("jobs.ashbyhq.com", "/acme/00000000-0000-0000-0000-000000000000"),
  { ats: "ashby", org: "acme", postingId: "00000000-0000-0000-0000-000000000000" });
assert.equal(detect("job-boards.greenhouse.io", "/acme"), null, "a board listing is not a posting");
assert.equal(detect("boards.greenhouse.io", "/embed/job_board", "?for=acme"), null, "the listing embed is not the form");

// --- a foreign page is described for the popup, never detected
const F = page("www.samsara.com", "/company/careers/roles/8082091", "?gh_jid=8082091",
  { embedFor: "samsara", iframeSrc: "https://boards.greenhouse.io/embed/job_app?for=samsara&token=8082091" });
assert.equal(F.detectPosting(), null);
same(F.embeddedHint(), { host: "www.samsara.com", jobId: "8082091", board: "samsara", frame: { board: "samsara", jobId: "8082091" } });
same(page("evil.example.com", "/jobs", "?gh_jid=4000000", { embedFor: "acme" }).embeddedHint(),
  { host: "evil.example.com", jobId: "4000000", board: "acme", frame: null }, "no frame: nothing to fill, only a description");
same(page("evil.example.com", "/jobs", "?gh_jid=4000000", { iframeSrc: "https://evilgreenhouse.io/embed/job_app?for=acme&token=1" }).embeddedHint().frame,
  null, "an iframe on a look-alike host is not the Greenhouse frame");
assert.equal(page("www.samsara.com", "/careers").embeddedHint().jobId, null, "no board is ever guessed from the domain");
assert.equal(page("www.samsara.com", "/careers").embeddedHint().board, null);
assert.equal(page("job-boards.greenhouse.io", "/acme/jobs/1").embeddedHint(), null, "on an ATS origin detectPosting applies instead");

// --- the worker's matcher agrees with the content script's
const vectors = ["job-boards.greenhouse.io", "boards.greenhouse.io", "job-boards.eu.greenhouse.io", "boards.eu.greenhouse.io",
  "jobs.ashbyhq.com", "x.ashbyhq.com", "evilgreenhouse.io", "notashbyhq.com", "greenhouse.io", "ashbyhq.com",
  "jobs.ashbyhq.com.evil.example", "www.samsara.com", "", "JOB-BOARDS.GREENHOUSE.IO"];
const pageAtsOfHost = page("x", "/").atsOfHost;
for (const host of vectors) assert.equal(workerAtsOfHost(host), pageAtsOfHost(host), `agree on ${JSON.stringify(host)}`);
assert.equal(workerAtsOfHost("job-boards.greenhouse.io"), "greenhouse");
assert.equal(workerAtsOfHost("jobs.ashbyhq.com"), "ashby");
assert.equal(workerAtsOfHost("evilgreenhouse.io"), null);
assert.equal(atsOfUrl("https://boards.greenhouse.io/embed/job_app?for=acme&token=1"), "greenhouse");
assert.equal(atsOfUrl("https://www.samsara.com/careers?gh_jid=1"), null);
assert.equal(atsOfUrl("not a url"), null);

console.log("extract.test.mjs: all assertions passed");
