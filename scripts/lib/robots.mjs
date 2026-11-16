// Reads a robots.txt the way a crawler does: by group. The smoke check
// (scripts/smoke.mjs) asks what the rules for every crawler ("*") say, so a
// "Disallow: /" addressed to one named crawler is not read as the site
// closing itself. Cloudflare's managed robots.txt puts exactly such groups in
// front of ours when an AI crawler policy is set (docs/BOTS-AND-SEO.md).

/**
 * The Allow and Disallow rules that apply to a crawler with no group of its
 * own: every group that names "*", merged.
 * A group is one or more User-agent lines followed by its rules; comments
 * and blank lines are skipped, and field names are case-insensitive.
 * @param {string} text robots.txt
 * @returns {{ allow: string[], disallow: string[] }}
 */
export function rulesForEveryone(text) {
  const rules = { allow: [], disallow: [] };
  let agents = [];
  let inAgents = false; // still reading this group's User-agent lines
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!inAgents) agents = [];
      agents.push(value.toLowerCase());
      inAgents = true;
      continue;
    }
    inAgents = false;
    if ((field === "allow" || field === "disallow") && agents.includes("*")) rules[field].push(value);
  }
  return rules;
}

/** Every crawler may read the site: "/" is allowed and not disallowed for "*". */
export function openToEveryone(text) {
  const { allow, disallow } = rulesForEveryone(text);
  return allow.includes("/") && !disallow.includes("/");
}

/** Every crawler is turned away: "/" is disallowed for "*". */
export function closedToEveryone(text) {
  return rulesForEveryone(text).disallow.includes("/");
}
