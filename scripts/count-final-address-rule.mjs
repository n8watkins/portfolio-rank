#!/usr/bin/env node
// Read only: how many listed sites the address rule would act on once it reads
// the address a site ends at after its redirects as well as the listed one
// (pipeline/junk-rules.mjs addressNotPortfolio; #292), split the way the
// night's roster pass splits them (lib/reviews/door.mjs addressRows):
//   remove   never graded, no decision on record: the rule's automatic removal
//            (with Undo, behind REVIEW_AUTO_APPLY and the 5-a-night brake)
//   hold     graded a portfolio before: waits for the owner
//   skip     the owner kept it, a case is open, or a decision is on record
// Only sites caught by the final address are new; the listed-address hits are
// today's rule and are counted apart. Nothing is written.
//
// Run by the owner or the orchestrator with a read-only token:
//   pass-env run -- node scripts/count-final-address-rule.mjs [--list]
import path from "node:path";
import { LISTED_NOT_DOWN, pipelineDb } from "../pipeline/roster.mjs";
import { addressNotPortfolio } from "../pipeline/junk-rules.mjs";
import { parseRubric } from "../pipeline/rubric-history.mjs";
import { guardedForReview } from "../pipeline/portfolio-guard.mjs";
import { OPEN_CASE_SQL, OWNER_KEEPS_SQL } from "../lib/reviews/store.mjs";

const db = pipelineDb(path.join(import.meta.dirname, ".."));
const list = process.argv.includes("--list");
const rows = (
  await db.execute(
    `SELECT p.url, p.final_url, p.facts, p.ai_rubric,
            CASE WHEN ${OPEN_CASE_SQL("p")} THEN 1 ELSE 0 END AS open_case,
            CASE WHEN ${OWNER_KEEPS_SQL("p")} THEN 1 ELSE 0 END AS owner_keeps
     FROM portfolios p WHERE ${LISTED_NOT_DOWN("p")}`
  )
).rows;
const out = { listed: [], remove: [], hold: [], skip: [], noFinal: 0 };
for (const r of rows) {
  const hit = addressNotPortfolio(r);
  if (!r.final_url && !String(r.facts ?? "").includes("final_url")) out.noFinal++;
  if (!hit) continue;
  if (!hit.forwarded) {
    out.listed.push(String(r.url));
    continue;
  }
  const graded = parseRubric(r.ai_rubric);
  const entry = `${r.url} -> ${hit.url}`;
  if (Number(r.open_case) || Number(r.owner_keeps) || (graded && (graded.is_portfolio === false || guardedForReview(graded)))) out.skip.push(entry);
  else if (graded) out.hold.push(entry);
  else out.remove.push(entry);
}
console.log(`listed sites read: ${rows.length} (${out.noFinal} with no stored final address, which the rule cannot read)`);
console.log(`caught on the listed address (today's rule): ${out.listed.length}`);
console.log(`newly caught on the final address: ${out.remove.length + out.hold.length + out.skip.length}`);
console.log(`  removed automatically: ${out.remove.length}`);
console.log(`  held for the owner: ${out.hold.length}`);
console.log(`  left alone (a decision or an open case): ${out.skip.length}`);
if (list) for (const k of ["remove", "hold", "skip"]) for (const e of out[k]) console.log(`${k}\t${e}`);
