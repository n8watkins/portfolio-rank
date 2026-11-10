// A read-only check of a deployed site, run by the deploy workflow after each
// deploy (DEPLOY.md "How a change ships"): staging must pass before
// production deploys, and production is checked right after its deploy.
//   node scripts/smoke.mjs https://staging.portfoliorank.n8builds.dev --staging
//   node scripts/smoke.mjs https://portfoliorank.n8builds.dev
// It only sends GETs plus the sign-in start (which writes nothing), so it is
// safe against production. Retries cover the minute a new custom domain or
// version can take to answer everywhere.
const [base, ...flags] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke.mjs BASE_URL [--staging]");
  process.exit(1);
}
const origin = new URL(base).origin;
const staging = flags.includes("--staging");
const failures = [];

const UA = "portfolio-rank-smoke (+https://github.com/n8watkins/portfolio-rank)";

async function get(path, init = {}) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(origin + path, {
        redirect: "manual",
        ...init,
        headers: { "user-agent": UA, ...init.headers },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status < 500) return res;
      last = new Error(`${path}: HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
  throw last;
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

function noindexed(res) {
  return /noindex/i.test(res.headers.get("x-robots-tag") ?? "");
}

let shotPath = null;

await check("home page renders the ranking", async () => {
  const res = await get("/");
  expect(res.status === 200, `HTTP ${res.status}`);
  const html = await res.text();
  shotPath = html.match(/\/shots\/[0-9a-f]+\/hero\.jpg\?v=[0-9a-z]+/)?.[0] ?? null;
  expect(shotPath, "no screenshot links (an empty ranking?)");
  expect(html.includes("data-staging-ribbon") === staging, staging ? "no Staging ribbon" : "the Staging ribbon is showing");
  expect(/<meta name="robots" content="noindex/.test(html) === staging, staging ? "no robots noindex meta tag" : "a robots noindex meta tag");
  expect(noindexed(res) === staging, staging ? "no X-Robots-Tag: noindex header" : "an X-Robots-Tag: noindex header");
});

await check("a page read from the database at request time (/top)", async () => {
  const res = await get("/top");
  expect(res.status === 200, `HTTP ${res.status}`);
  expect(/\/shots\/[0-9a-f]+\//.test(await res.text()), "no screenshot links");
});

await check("a screenshot from R2", async () => {
  expect(shotPath, "no screenshot link on the home page");
  const res = await get(shotPath);
  expect(res.status === 200, `HTTP ${res.status}`);
  expect(res.headers.get("content-type") === "image/jpeg", `content-type ${res.headers.get("content-type")}`);
  expect((await res.arrayBuffer()).byteLength > 1000, "an empty image");
});

await check("a JSON API (/api/polls)", async () => {
  const res = await get("/api/polls");
  expect(res.status === 200, `HTTP ${res.status}`);
  await res.json();
});

await check("robots.txt", async () => {
  const res = await get("/robots.txt");
  expect(res.status === 200, `HTTP ${res.status}`);
  const text = await res.text();
  if (staging) expect(/^Disallow: \/\s*$/m.test(text), "does not disallow everything");
  else expect(/^Allow: \/\s*$/im.test(text) && !/^Disallow: \/\s*$/m.test(text), "production robots.txt blocks crawlers");
});

await check("GitHub sign-in starts with this site's callback", async () => {
  const csrfRes = await get("/api/auth/csrf");
  expect(csrfRes.status === 200, `csrf HTTP ${csrfRes.status}`);
  const { csrfToken } = await csrfRes.json();
  const cookie = csrfRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const res = await get("/api/auth/signin/github", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken, callbackUrl: origin + "/" }),
  });
  // With X-Auth-Return-Redirect Auth.js answers JSON { url } instead of a 302.
  const location = res.status === 200 ? (await res.json()).url : res.headers.get("location");
  expect(location, `HTTP ${res.status}, no redirect`);
  const url = new URL(location);
  expect(url.origin + url.pathname === "https://github.com/login/oauth/authorize", `redirects to ${url.origin}${url.pathname}`);
  const clientId = url.searchParams.get("client_id");
  expect(clientId && clientId !== "undefined", "no client_id (AUTH_GITHUB_ID unset?)");
  const callback = url.searchParams.get("redirect_uri");
  expect(callback === `${origin}/api/auth/callback/github`, `callback ${callback}`);
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed on ${origin}`);
  process.exit(1);
}
console.log(`\nall checks passed on ${origin}${staging ? " (staging)" : ""}`);
