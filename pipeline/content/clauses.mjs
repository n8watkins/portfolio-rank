// Finished clauses from a fact sheet (docs/audits/blog-engine.md, "The fact
// sheet sets traps"): code turns the sheet's facts into short, correct
// sentences with their {{placeholders}} and links, so the writer never sees
// a raw label to copy, never pairs two facts wrongly ("earns 5 out of 3.2")
// and never words a tie as one winner. Each clause says which facts it uses
// and which named site it is about; the plan (plan.mjs) hands them to the
// sections. Pure: no I/O, no Gemini.

const TOP = /(?:of )?(?:the top-graded portfolios|S and A portfolios|portfolios graded A or higher|the top group)/i;
const REST = /(?:of )?(?:all other graded portfolios|other portfolios|everyone else|the rest)/i;
const ph = (id) => `{{${id}}}`;

/** The comparison family of a label with the group taken out ("Average X score (1 to 5)", "Share ... with X"). */
function family(label) {
  return label.replace(TOP, "@").replace(REST, "@").replace(/\s+/g, " ").trim();
}

/** A sentence for a top-against-rest pair of facts, by the shape of its label. */
function compareText(label, top, rest, v = 0) {
  let m;
  if ((m = label.match(/^Average (.+?) score \(1 to 5\)/i))) {
    // Two wordings, alternating, so clauses side by side never open the same way.
    return v % 2 ? `The top-graded portfolios average ${ph(top.id)} on ${m[1]}, against ${ph(rest.id)} for everyone else, on the 1 to 5 scale.` : `On ${m[1]}, the top-graded portfolios average ${ph(top.id)} and everyone else ${ph(rest.id)}, on the judge's 1 to 5 scale.`;
  }
  if ((m = label.match(/^Share of .*? with (.+)$/i))) {
    const what = /^fits /i.test(m[1]) ? m[1].replace(/^fits /i, "fit ") : `have ${m[1]}`;
    return `${ph(top.id)} of the top-graded portfolios ${what}, against ${ph(rest.id)} of everyone else.`;
  }
  if (/^Median page weight/i.test(label)) {
    return `At the median, a top-graded portfolio weighs ${ph(top.id)} on first load, and everyone else's ${ph(rest.id)}.`;
  }
  if (/^Median number of network requests/i.test(label)) {
    return `At the median, a top-graded portfolio makes ${ph(top.id)} network requests on first load, and everyone else's ${ph(rest.id)}.`;
  }
  return `${label.replace(TOP, "").replace(/\s+/g, " ").trim()}: ${ph(top.id)} for the top-graded portfolios, ${ph(rest.id)} for everyone else.`;
}

/** A sentence about one named site, from its fact's label (positive facts only). */
function namedText(f, name, url) {
  const link = `[${name}](${url})`;
  const rest = f.label.replace(/^.+?\s\([^)]*\)\s*/, "");
  let m;
  if ((m = rest.match(/^scores (\d) out of 5 on (.+)$/i))) {
    // A list of axes (display is the list) or one axis (display is the score).
    if (!/^\d/.test(String(f.display))) return `${link} gets full marks on ${ph(f.id)}.`;
    return m[1] === "5" ? `${link} scores ${ph(f.id)} on ${m[2]}, the top of the 1 to 5 scale.` : `${link} scores ${ph(f.id)} on ${m[2]}, on the 1 to 5 scale.`;
  }
  if (/^has the AI judge's highest grade/i.test(rest) || /^is graded$/i.test(rest)) return `${link} has one of the AI judge's highest grades.`;
  if ((m = rest.match(/^has (?:the highest grade|one of the highest grades) and (.+)$/i))) return `${link} has one of the AI judge's highest grades and ${m[1]}.`;
  if (/^is at number$/i.test(rest)) return `${link} is ${ph(f.id)} on the board this week.`;
  if (/^climbed, in places$/i.test(rest)) return `${link} climbed ${ph(f.id)} places this week.`;
  if (/^page weight, first load$/i.test(rest)) return `${link} weighs ${ph(f.id)} on first load.`;
  return `${link}: ${rest} ${ph(f.id)}.`;
}

/**
 * The clauses of a sheet:
 *   { id, text, facts: [ids], kind: "compare" | "example" | "count" | "tie" | "fact", about?: url, axis?: string }
 * Comparison pairs first (in sheet order), then ties and superlatives, then
 * counts, then one clause per named site (its facts merged where they
 * belong together, a climb and the rank it reached).
 */
export function clausesOf(sheet) {
  const facts = sheet.facts ?? [];
  const used = new Set();
  const out = [];
  const add = (c) => {
    out.push({ id: `c${out.length + 1}`, ...c });
    for (const f of c.facts) used.add(f);
  };

  // Top against rest: pair facts whose labels differ only by the group.
  for (const f of facts) {
    if (used.has(f.id) || !TOP.test(f.label) || f.about) continue;
    const other = facts.find((g) => !used.has(g.id) && g.id !== f.id && !g.about && REST.test(g.label) && family(g.label) === family(f.label));
    if (!other) continue;
    const axis = f.label.match(/^Average (.+?) score/i)?.[1] ?? f.label.match(/ with (.+)$/i)?.[1] ?? null;
    add({ text: compareText(f.label, f, other, out.length), alt: compareText(f.label, f, other, out.length + 1), facts: [f.id, other.id], kind: "compare", ...(axis ? { axis } : {}) });
  }

  // Ties and superlatives, worded by code: a tie is never one winner.
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const s of sheet.superlatives ?? []) {
    const [a, b] = s.factIds.map((i) => byId.get(i));
    if (!a || s.factIds.some((i) => used.has(i))) continue;
    if (s.term === "biggest lead" && b) {
      add({ text: s.tied ? `${ph(a.id)} tie for the biggest lead of the top-graded portfolios, ${ph(b.id)} each.` : `The top-graded portfolios lead by the most on ${ph(a.id)}, by ${ph(b.id)}.`, facts: [a.id, b.id], kind: "tie" });
    } else if (s.term === "smallest gap") {
      add({ text: s.tied ? `The gap is smallest, and tied, on ${ph(a.id)}.` : `The gap between the top-graded portfolios and everyone else is smallest on ${ph(a.id)}.`, facts: [a.id], kind: "tie" });
    }
  }

  // Counts and other neutral facts that aren't about a named site.
  for (const f of facts) {
    if (used.has(f.id) || f.about || f.tone === "negative") continue;
    if (/^Number of axes sharing/i.test(f.label)) continue; // only a tie's count; the tie clause carries it.
    let text;
    if (/^Portfolios graded by the AI judge$/i.test(f.label)) text = `The AI judge has graded ${ph(f.id)} portfolios.`;
    else if (/^Share of (?:all graded|measured) portfolios (?:that are )?(?:top-graded|graded A or higher|graded S or A)/i.test(f.label)) text = `${ph(f.id)} of graded portfolios are top-graded.`;
    else if (/highest grade, a small part|^Portfolios graded (?:S|SSS), the top tier/i.test(f.label)) text = `${ph(f.id)} portfolios have the AI judge's highest grade, a small part of the top-graded group.`;
    else if (/^Portfolios measured and graded$/i.test(f.label)) text = `The capture measured ${ph(f.id)} graded portfolios.`;
    else if (/^Of them, (?:top-graded|graded)/i.test(f.label)) text = `Of those, ${ph(f.id)} are top-graded.`;
    else if (/^Portfolios on the board this week$/i.test(f.label)) text = `${ph(f.id)} portfolios are on the board this week.`;
    else if (/^Portfolios that moved up$/i.test(f.label)) text = `${ph(f.id)} portfolios moved up this week.`;
    else if (/^New entries in the top 10$/i.test(f.label)) text = `The top ten has ${ph(f.id)} new entries this week.`;
    else text = `${f.label}: ${ph(f.id)}.`;
    add({ text, facts: [f.id], kind: "count" });
  }

  // Named sites: one clause per site, its related facts merged.
  const sites = new Map();
  for (const f of facts) {
    if (used.has(f.id) || !f.about || f.tone !== "positive") continue;
    const n = (sheet.names ?? []).find((x) => x.url === f.about) ?? { name: f.label.replace(/\s\(.*$/, "").replace(/'s rank.*$/, ""), url: f.about };
    if (!sites.has(f.about)) sites.set(f.about, { name: n.name, url: f.about, facts: [] });
    sites.get(f.about).facts.push(f);
  }
  for (const { name, url, facts: fs } of sites.values()) {
    const climb = fs.find((f) => /climbed, in places/i.test(f.label));
    const rank = fs.find((f) => /'s rank this week$/i.test(f.label));
    const parts = [];
    const ids = [];
    if (climb && rank) {
      parts.push(`[${name}](${url}) climbed ${ph(climb.id)} places this week, to ${ph(rank.id)}.`);
      ids.push(climb.id, rank.id);
    }
    // The broadest strength first; single-axis repeats of it are left out.
    const list = fs.find((f) => /scores 5 out of 5 on .+,| and /i.test(f.label) && !/^\d/.test(String(f.display)));
    for (const f of fs) {
      if (ids.includes(f.id)) continue;
      if (list && f !== list && /scores 5 out of 5 on /i.test(f.label) && /^\d/.test(String(f.display))) continue;
      parts.push(namedText(f, name, url));
      ids.push(f.id);
    }
    if (!parts.length) continue;
    // One sentence: the site linked once, its other facts joined on ("... and gets full marks on ..."),
    // so the post never has two sentences in a row starting with the same name.
    const rest = parts.slice(1).map((p) => p.replace(`[${name}](${url}) `, "").replace(/\.$/, ""));
    const text = rest.length ? `${parts[0].replace(/\.$/, "")}, and ${rest.join(", and ")}.` : parts[0];
    const axes = fs.flatMap((f) => (f.label.match(/scores 5 out of 5 on (.+)$/i)?.[1] ?? "").split(/,\s*|\s+and\s+/)).filter(Boolean);
    add({ text, facts: ids, kind: "example", about: url, name, axes });
  }
  return out;
}
