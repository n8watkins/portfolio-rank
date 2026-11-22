// The facts and signals see buttons and other non-link controls, not only
// <a href> (facts audit, 2026-11-21, scripts/experiments/facts-audit/), and
// the capture reads a page once its text has stopped growing
// (pipeline/render.mjs settleText). The two fixtures are the rendered pages
// of two listed sites the owner found stored with no resume, as the capture
// read them, trimmed (scripts/experiments/facts-audit/trim-fixture.mjs).
// Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FACTS_VERSION, measureFacts, pageLinks, projectLinkCandidates } from "../pipeline/facts.mjs";
import { extractControls, LABEL_MAX } from "../pipeline/page-controls.mjs";
import { portfolioSignals } from "../pipeline/signals.mjs";
import { settleText } from "../pipeline/render.mjs";

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "facts", name), "utf8");

test("adityapillai.dev: the hero's View Resume button is a resume", () => {
  const html = fixture("adityapillai.dev.html");
  assert.match(html, /<button[^>]*aria-label="View Resume"/, "the fixture has the button and no resume link");
  const f = measureFacts({ html, text: "", url: "https://adityapillai.dev", finalUrl: "https://www.adityapillai.dev/", name: "Aditya Pillai" });
  assert.equal(f.v, FACTS_VERSION);
  assert.equal(f.resume, true);
  assert.equal(f.github, true);
  assert.equal(f.contact, true);
  assert.equal(f.signals.resume, true);
});

test("kalpsenghani.com: a Resume button and an icon-only Download Resume button are a resume", () => {
  const html = fixture("kalpsenghani.com.html");
  const f = measureFacts({ html, text: "", url: "https://kalpsenghani.com", name: "Kalp Senghani" });
  assert.equal(f.resume, true);
  assert.equal(f.signals.resume, true);
  assert.equal(f.signals.projects, true, "the My Work link goes to #projects");
});

test("a resume button counts; the word resume in prose, or in a big clickable card, does not", () => {
  const url = "https://ana.dev";
  assert.equal(measureFacts({ html: `<button type="button">Download CV</button>`, url }).resume, true);
  assert.equal(measureFacts({ html: `<div role="button" tabindex="0"><span>Résumé</span></div>`, url }).resume, true);
  assert.equal(measureFacts({ html: `<button aria-label="Open my resume"><svg></svg></button>`, url }).resume, true);
  assert.equal(measureFacts({ html: `<span onclick="window.open('/files/ana_resume.pdf')">Download</span>`, url }).resume, true, "a script that opens the resume PDF");
  assert.equal(
    measureFacts({ html: `<article><h2>How I rewrote my resume</h2><p>Last year I rewrote my resume three times before it worked.</p></article>`, url }).resume,
    false,
    "a blog post about a resume is not a resume"
  );
  const card = `<div role="button"><h3>Job board</h3><p>Upload a resume, match it with openings and track every application in one place.</p></div>`;
  assert.ok(card.replace(/<[^>]+>/g, "").length > LABEL_MAX);
  assert.equal(measureFacts({ html: card, url }).resume, false, "a project card that mentions resumes is not a resume button");});

test("GitHub and contact from buttons; a project opened from a button is a project link", () => {
  const url = "https://ana.dev";
  const html = `<button onclick="window.open('https://github.com/ana/weather-app','_blank')">Code</button>
    <button aria-label="GitHub"><svg></svg></button>
    <button onclick="location.href='https://weather.ana.dev'">Live demo</button>
    <button class="cta">Contact me</button>`;
  const f = measureFacts({ html, url });
  assert.equal(f.github, true);
  assert.equal(f.contact, true);
  assert.deepEqual(projectLinkCandidates(pageLinks(html, url), url), ["https://github.com/ana/weather-app", "https://weather.ana.dev/"]);
  const s = portfolioSignals(html, "Ana");
  assert.equal(s.github, true);
  assert.equal(s.contact, true);
  assert.equal(measureFacts({ html: `<button onclick="window.open('https://github.com/features')">Features</button>`, url }).github, false, "github.com's own pages are not a profile");
});

test("controls: labels from text, aria-label, title and image alt; long text is not read for words", () => {
  const c = extractControls(`<button title="Download Resume"><img alt="file icon"></button><div role="tab">About</div><input type="submit" value="Send">`, "https://ana.dev/");
  assert.deepEqual(
    c.map((x) => [x.tag, x.label]),
    [
      ["button", "Download Resume file icon"],
      ["div", "About"],
      ["input", "Send"],
    ]
  );
});

/** A fake page whose text length follows `lengths`, one value per sample. */
function fakePage(lengths) {
  let i = 0;
  let clock = 0;
  return {
    page: {
      evaluate: async () => lengths[Math.min(i++, lengths.length - 1)],
      waitForTimeout: async (ms) => {
        clock += ms;
      },
    },
    clock: () => clock,
  };
}

test("settleText waits while the text grows, stops once it holds, and has a ceiling", async (t) => {
  const real = Date.now;
  let base = 0;
  t.after(() => {
    Date.now = real;
  });
  const run = async (lengths, opts) => {
    const fake = fakePage(lengths);
    base = real();
    Date.now = () => base + fake.clock();
    return settleText(fake.page, { pollMs: 500, quietMs: 2000, maxMs: 10000, ...opts });
  };
  const still = await run([3000]);
  assert.equal(still.grew, 0);
  assert.ok(still.ms >= 2000 && still.ms <= 2500, `a still page costs the quiet time (${still.ms} ms)`);
  const late = await run([0, 0, 400, 1800, 2900, 2900]);
  assert.equal(late.grew, 2900);
  assert.ok(late.ms >= 4000, `it waits until the text stops growing (${late.ms} ms)`);
  const ticker = await run(Array.from({ length: 100 }, (_, n) => n));
  assert.ok(ticker.ms <= 10500, `a page that never stops changing gets the ceiling (${ticker.ms} ms)`);
});
