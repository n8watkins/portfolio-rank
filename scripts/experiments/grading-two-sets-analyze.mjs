#!/usr/bin/env node
// Analysis of "Grading test (two sets)". Reads the answers of both models,
// in the same shape, from ~/research/.../grading-two-sets/<model>/<step>/
// (model "gemini" written by grading-two-sets-run.mjs, model "expert"
// written by the Sonnet runs of expert-runs.md), plus groupings.json,
// sites.json and pass-rules.json. The answer key is the expert's "solo"
// step. Writes analysis.json next to the answers and prints the verdicts.
//
//   node scripts/experiments/grading-two-sets-analyze.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EXP, RES, readJson, writeJson } from "./grading-two-sets-lib.mjs";
import { CHECKS, PARTS } from "./grading-two-sets-run.mjs";

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** Every answer of a model: answers[step][id], and where each id sat in each batch. */
export function loadAnswers(dir) {
  const answers = {};
  const position = {};
  if (!fs.existsSync(dir)) return { answers, position };
  for (const step of fs.readdirSync(dir)) {
    const sd = path.join(dir, step);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const f of fs.readdirSync(sd).filter((x) => x.endsWith(".json"))) {
      const o = readJson(path.join(sd, f));
      for (const [id, a] of Object.entries(o.answers ?? {})) (answers[step] ??= {})[id] = a;
      if (o.ids?.length > 1) o.ids.forEach((id, i) => ((position[step] ??= {})[id] = i + 1));
    }
  }
  return { answers, position };
}

const both = (c) => Boolean(c?.desktop && c?.phone);

/** Per part: how many of the shared ids are within 1 point and exactly equal, and the mean difference x - y. */
function compare(x, y, ids) {
  const shared = ids.filter((id) => x?.[id] && y?.[id]);
  return Object.fromEntries(
    PARTS.map((p) => {
      const d = shared.map((id) => x[id][p].score - y[id][p].score);
      return [p, { n: shared.length, within1: d.filter((v) => Math.abs(v) <= 1).length, exact: d.filter((v) => v === 0).length, mean_diff: r2(mean(d)) }];
    })
  );
}

function checklist(x, key, ids) {
  const shared = ids.filter((id) => x?.[id] && key?.[id]);
  return Object.fromEntries(
    CHECKS.map((q) => [
      q,
      {
        n: shared.length,
        same_both_views: shared.filter((id) => both(x[id].five_second[q]) === both(key[id].five_second[q])).length,
        same_desktop: shared.filter((id) => x[id].five_second[q].desktop === key[id].five_second[q].desktop).length,
        same_phone: shared.filter((id) => x[id].five_second[q].phone === key[id].five_second[q].phone).length,
        yes_both_views: shared.filter((id) => both(x[id].five_second[q])).length,
      },
    ])
  );
}

function fives(x, ids) {
  const got = ids.filter((id) => x?.[id]);
  return Object.fromEntries(PARTS.map((p) => [p, { n: got.length, fives: got.filter((id) => x[id][p].score === 5).length, share: r2(got.filter((id) => x[id][p].score === 5).length / Math.max(1, got.length)), dist: [1, 2, 3, 4, 5].map((v) => got.filter((id) => x[id][p].score === v).length) }]));
}

/** One model on one set. */
export function setReport({ answers, position }, key, set, plan, sites) {
  const ids = sites.sets[set].map((s) => s.id);
  const junk = sites.sets[set].find((s) => s.junk)?.id;
  const S = answers.solo ?? {};
  const passes = ["pass1", "pass2", "pass3"];
  const rep = { set };
  rep.agreement_with_key = Object.fromEntries(["solo", ...passes, "pass1-repeat"].filter((s) => answers[s]).map((s) => [s, compare(answers[s], key, ids)]));
  rep.share_of_fives = Object.fromEntries(["solo", ...passes].filter((s) => answers[s]).map((s) => [s, fives(answers[s], ids)]));
  rep.checklist_vs_key = answers.solo ? checklist(S, key, ids) : null;
  rep.junk = { id: junk, flagged: Object.fromEntries(["solo", "solo-repeat", ...passes, "pass1-repeat"].filter((s) => answers[s]?.[junk]).map((s) => [s, answers[s][junk].is_portfolio.answer === false])) };
  rep.is_portfolio_false = Object.fromEntries(["solo", ...passes].filter((s) => answers[s]).map((s) => [s, ids.filter((id) => answers[s][id]?.is_portfolio.answer === false)]));
  // Consistency 1: the same site, an identical solo request.
  const rIds = plan.sets[set].solo_repeat;
  rep.consistency_identical_solo = answers["solo-repeat"] ? { ids: rIds, ...compare(answers["solo-repeat"], S, rIds), checklist_same: CHECKS.reduce((n, q) => n + rIds.filter((id) => answers["solo-repeat"][id] && both(answers["solo-repeat"][id].five_second[q]) === both(S[id]?.five_second[q])).length, 0) } : null;
  // Amendment control (Gemini only): the solo request again with the free-text level_line schema.
  rep.schema_change_solo = answers["solo-freetext"]
    ? { ids: rIds, ...compare(answers["solo-freetext"], S, rIds), note: "free-text level_line against the enum schema, same sites, otherwise the same solo request; compare with consistency_identical_solo to separate the schema effect from noise" }
    : null;
  // Consistency 2: the same batch, an identical request.
  rep.consistency_identical_batch = answers["pass1-repeat"] ? compare(answers["pass1-repeat"], answers.pass1, ids) : null;
  // Consistency 3: the same site in a different batch (passes 1, 2 and 3).
  if (passes.every((p) => answers[p])) {
    rep.consistency_different_batch = Object.fromEntries(
      PARTS.map((p) => {
        const pairs = [["pass1", "pass2"], ["pass1", "pass3"], ["pass2", "pass3"]];
        let exact = 0;
        let within1 = 0;
        let n = 0;
        let allSame = 0;
        for (const id of ids) {
          const v = passes.map((s) => answers[s][id]?.[p].score);
          if (v.some((x) => x == null)) continue;
          if (new Set(v).size === 1) allSame++;
          for (const [a, b] of pairs) {
            const d = answers[a][id][p].score - answers[b][id][p].score;
            n++;
            if (d === 0) exact++;
            if (Math.abs(d) <= 1) within1++;
          }
        }
        return [p, { pairs: n, exact, within1, sites_same_in_all_three: allSame, sites: ids.length }];
      })
    );
  }
  // Batch vs solo (the same model).
  rep.batch_vs_solo = Object.fromEntries([...passes, "pass1-repeat"].filter((s) => answers[s] && answers.solo).map((s) => [s, compare(answers[s], S, ids)]));
  // Position: batch score minus the same model's solo score, by position.
  if (answers.solo) {
    rep.position = Object.fromEntries(
      passes.filter((s) => answers[s]).map((s) => [
        s,
        [1, 2, 3, 4, 5].map((pos) => {
          const at = ids.filter((id) => position[s]?.[id] === pos && answers[s][id] && S[id]);
          const per = Object.fromEntries(PARTS.map((p) => [p, r2(mean(at.map((id) => answers[s][id][p].score - S[id][p].score)))]));
          return { position: pos, n: at.length, mean_offset_all_parts: r2(mean(at.flatMap((id) => PARTS.map((p) => answers[s][id][p].score - S[id][p].score)))), ...per };
        }),
      ])
    );
  }
  return rep;
}

/** The pass rules (pass-rules.json), applied to Gemini's reports. */
export function verdicts(g, rules) {
  const out = {};
  const sets = Object.keys(g);
  const R = rules.rules;
  const per = (fn) => Object.fromEntries(sets.map((s) => [s, fn(g[s])]));
  out.spread = per((r) => r.share_of_fives.solo && PARTS.every((p) => r.share_of_fives.solo[p].share < R.spread.max_share_of_fives));
  out.agreement = per((r) => r.agreement_with_key.solo && PARTS.every((p) => r.agreement_with_key.solo[p].within1 >= R.agreement.min_within1));
  out.checklist = per((r) => r.checklist_vs_key && R.checklist.questions.every((q) => r.checklist_vs_key[q].same_both_views >= R.checklist.min_same));
  out.consistency = (() => {
    const c = sets.map((s) => g[s].consistency_identical_solo);
    if (c.some((x) => !x)) return null;
    const perSet = PARTS.every((p) => c.every((x) => x[p].exact >= R.consistency.min_same_per_set));
    const total = PARTS.every((p) => c.reduce((n, x) => n + x[p].exact, 0) >= R.consistency.min_same_both_sets);
    return perSet && total;
  })();
  out.junk = sets.every((s) => g[s].junk.flagged.solo === true);
  out.batching = per((r) => ["pass1", "pass2", "pass3"].every((s) => r.batch_vs_solo[s] && PARTS.every((p) => r.batch_vs_solo[s][p].within1 >= R.batching.min_within1)));
  out.position = per((r) => {
    if (!r.position) return null;
    for (let pos = 0; pos < 5; pos++) {
      const offs = ["pass1", "pass2", "pass3"].map((s) => r.position[s]?.[pos]?.mean_offset_all_parts);
      if (offs.some((x) => x == null)) return null;
      const sameSign = offs.every((x) => x > 0) || offs.every((x) => x < 0);
      if (sameSign && Math.abs(mean(offs)) >= R.position.max_consistent_offset) return false;
    }
    return true;
  });
  return out;
}

/** Requests, retries and timing from the Gemini run state. */
export function requestReport(state, rawDir = null) {
  if (!state) return null;
  const a = state.attempts ?? [];
  const items = Object.values(state.items ?? {});
  const steps = {};
  for (const i of items) {
    const s = (steps[i.step] ??= { requests: 0, start: null, end: null, input_tokens: 0, output_tokens: 0, thoughts_tokens: 0 });
    s.requests++;
    if (i.started && (!s.start || i.started < s.start)) s.start = i.started;
    if (i.finished && (!s.end || i.finished > s.end)) s.end = i.finished;
    s.input_tokens += i.usage?.inputTokens ?? 0;
    s.output_tokens += i.usage?.outputTokens ?? 0;
    s.thoughts_tokens += i.usage?.thoughtsTokens ?? 0;
  }
  return {
    http_requests: state.http_requests,
    retries: a.filter((x) => x.retry).length,
    non_200: a.filter((x) => x.status !== 200).map((x) => ({ at: x.at, key: x.key, status: x.status, reason: x.reason })),
    by_status: a.reduce((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {}),
    broken_answers: items.flatMap((i) => (i.broken ?? []).map((b) => ({ key: i.key, ...b }))),
    pauses: state.pauses ?? [],
    level_score_mismatches: items.flatMap((i) => Object.entries(i.answers ?? {}).flatMap(([id, x]) => (x.notes ?? []).map((n) => `${i.key} ${id}: ${n}`))),
    identical_repeats: identicalRepeats(state, rawDir),
    steps,
  };
}

/**
 * The repeat requests must be byte-identical to the first ones. The hash is
 * taken from the raw log of the last HTTP attempt of each request (the one
 * that was answered), so a request re-sent after the amendment is compared as
 * it was answered, not as first tried.
 */
function identicalRepeats(state, rawDir) {
  const items = state.items ?? {};
  const answeredSha = (key) => {
    if (!rawDir || !fs.existsSync(rawDir)) return items[key]?.body_sha256;
    const files = fs.readdirSync(rawDir).filter((f) => f.startsWith(`${key.replace("/", "__")}__http`) && f.endsWith(".request.json")).sort();
    return files.length ? readJson(path.join(rawDir, files.at(-1))).body_sha256 : items[key]?.body_sha256;
  };
  const out = [];
  for (const [k, i] of Object.entries(items)) {
    if (i.step !== "solo-repeat" && i.step !== "pass1-repeat") continue;
    const orig = i.step === "solo-repeat" ? `solo/${i.ids[0]}` : k.replace("pass1-repeat/", "pass1/");
    out.push({ repeat: k, original: orig, identical: answeredSha(orig) === answeredSha(k) });
  }
  return out;
}

export function analyze({ res = RES, exp = EXP } = {}) {
  const plan = readJson(path.join(exp, "groupings.json"));
  const sites = readJson(path.join(exp, "sites.json"));
  const rules = readJson(path.join(exp, "pass-rules.json"));
  const expert = loadAnswers(path.join(res, "expert"));
  const gemini = loadAnswers(path.join(res, "gemini"));
  const key = expert.answers.solo ?? {};
  const out = { created_at: new Date().toISOString(), key: "expert solo (Claude Sonnet, one at a time)", note: "For the expert, agreement with the key is partly agreement with itself: read the expert's numbers as consistency, not accuracy.", models: {} };
  for (const [name, m] of [["gemini", gemini], ["expert", expert]]) {
    out.models[name] = Object.fromEntries(["A", "B"].map((set) => [set, setReport(m, key, set, plan, sites)]));
  }
  // Amendment: Claude Sonnet 5.5 through the API, Set A one at a time only,
  // with Gemini's solo prompt. The same model as the expert, so its agreement
  // with the key is partly the same model agreeing with itself under another prompt.
  // Claude through the API (amendments): Sonnet 5.5 and Haiku 5.5, the same
  // 58 requests (A and B solo, pass 1, the solo repeats) with Gemini's prompts.
  out.requests_claude_api = {};
  for (const folder of ["claude-sonnet-api", "claude-haiku-api"]) {
    const m = loadAnswers(path.join(res, folder));
    if (!m.answers.solo) continue;
    out.models[folder] = Object.fromEntries(
      ["A", "B"].map((set) => {
        const r = setReport(m, key, set, plan, sites);
        r.vs_gemini_solo = compare(m.answers.solo, gemini.answers.solo ?? {}, sites.sets[set].map((s) => s.id));
        return [set, r];
      })
    );
    const cs = path.join(res, folder, "state.json");
    if (fs.existsSync(cs)) {
      const st = readJson(cs);
      const items = Object.values(st.items ?? {});
      out.requests_claude_api[folder] = {
        http_requests: st.http_requests,
        answered: items.length,
        retries: (st.attempts ?? []).filter((a) => a.retry).length,
        non_200: (st.attempts ?? []).filter((a) => a.status !== 200),
        input_tokens: items.reduce((n, i) => n + (i.usage?.input_tokens ?? 0) + (i.usage?.cache_creation_input_tokens ?? 0) + (i.usage?.cache_read_input_tokens ?? 0), 0),
        output_tokens: items.reduce((n, i) => n + (i.usage?.output_tokens ?? 0), 0),
        cost_usd: Math.round(st.cost_usd * 10000) / 10000,
        first_at: items.map((i) => i.at).sort()[0] ?? null,
        last_at: items.map((i) => i.at).sort().at(-1) ?? null,
        stopped: st.stopped ?? null,
      };
    }
  }
  out.verdicts_gemini = verdicts(out.models.gemini, rules);
  const statePath = path.join(res, "gemini", "state.json");
  out.requests = requestReport(fs.existsSync(statePath) ? readJson(statePath) : null, path.join(res, "raw"));
  // Direct comparison: the same measures side by side.
  out.side_by_side = {};
  for (const set of ["A", "B"]) {
    const g = out.models.gemini[set];
    const e = out.models.expert[set];
    const safe = (f, r) => {
      try {
        return f(r) ?? null;
      } catch {
        return null;
      }
    };
    const extra = (f) => Object.fromEntries(["claude-sonnet-api", "claude-haiku-api"].filter((m) => out.models[m]?.[set]).map((m) => [m, safe(f, out.models[m][set])]));
    const row = (f) => ({ gemini: f(g), expert: f(e), ...extra(f) });
    out.side_by_side[set] = Object.fromEntries(
      PARTS.map((p) => [
        p,
        {
          solo_within1_of_key: row((r) => r.agreement_with_key.solo?.[p].within1),
          solo_exact_with_key: row((r) => r.agreement_with_key.solo?.[p].exact),
          share_of_fives_solo: row((r) => r.share_of_fives.solo?.[p].share),
          identical_solo_same: row((r) => r.consistency_identical_solo?.[p].exact),
          identical_batch_same: row((r) => r.consistency_identical_batch?.[p].exact),
          different_batch_same_pairs: row((r) => r.consistency_different_batch?.[p].exact),
          pass1_within1_of_own_solo: row((r) => r.batch_vs_solo.pass1?.[p].within1),
          pass1_mean_shift_vs_own_solo: row((r) => r.batch_vs_solo.pass1?.[p].mean_diff),
          solo_freetext_same_as_solo: row((r) => r.schema_change_solo?.[p].exact),
        },
      ])
    );
  }
  writeJson(path.join(res, "analysis.json"), out);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = analyze();
  console.log(JSON.stringify({ verdicts_gemini: out.verdicts_gemini, requests: { http: out.requests?.http_requests, retries: out.requests?.retries } }, null, 1));
}
