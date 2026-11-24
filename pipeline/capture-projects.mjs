// The site's own projects page, for a home page that shows fewer than 3
// projects (facts version 3, pipeline/facts.mjs projectsPageFor). It runs
// once per capture, after everything stored from the capture was taken (the
// readings and every screenshot), in the capture's own browser context, and
// it is only ever a plain GET of an <a href> on the same host:
//
//   1. load the link's address in a new tab (a hash route, "/#/projects", is
//      a load of the home page's own address, the part after "#" is never
//      sent, and the app's router shows the route: chiragsamal.github.io);
//   2. only when that answers an error status (an app served only through its
//      router answers 404 to a direct load, as eduardconstantin.github.io on
//      GitHub Pages does), press that same-site link on the home page, so
//      its router shows the page; never when a service worker controls the
//      page, since its requests would bypass the guard below, and never for a
//      hash route.
//
// Either way the page is read once its content has settled (settleAndRead):
// the links in its main content unchanged for a second and no data request
// in flight, within SETTLE_MAX_MS and the step's limit, so a list drawn from
// data fetched after the page opened is read with its links.
//
// While it runs every request that is not a GET is refused, and so are pings,
// beacons, event streams and web sockets; a new window is closed at once. The
// time limit bounds the work, not only the wait: what is still running when
// it passes is closed. A failure, a timeout, an error status or another host
// adds nothing and never fails the capture. Nothing is stored but the page's
// reading, and no screenshot is taken.
import { readRenderedPage } from "./gate.mjs";

/** The most the projects page may take, well inside the capture's SITE_LIMIT_MS (5 minutes). */
export const PROJECTS_PAGE_MS = 25_000;
/** The time kept, at the end of the step's limit, for the reading itself after the settling waits. */
const READ_RESERVE_MS = 2000;

/** Whether an address is a hash route ("https://ana.dev/#/projects", "#!/work"), not an in-page anchor. */
const isHashRoute = (u) => {
  try {
    return /^#!?\//.test(new URL(u).hash);
  } catch {
    return false;
  }
};

/** Request kinds that are never a plain page read. */
const REFUSED_TYPES = new Set(["ping", "beacon", "eventsource", "websocket"]);

const sameHost = (a, b) => {
  try {
    return new URL(a).hostname.replace(/^www\./, "").toLowerCase() === new URL(b).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
};
const pathOf = (u) => {
  try {
    return new URL(u).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
};

/**
 * Whether the page's text was replaced, not just animated: fewer than half of
 * the lines it had before (of more than 3 characters) are still there, or at
 * least 10 new lines arrived and they outnumber the old ones (an app that
 * keeps its menu and swaps the rest, as eduardconstantin.github.io does).
 */
export function swapped(before, now) {
  const lines = (t) => String(t ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length > 3);
  const old = lines(before);
  const cur = lines(now);
  if (!cur.length) return false;
  const was = new Set(old);
  const added = new Set(cur.filter((l) => !was.has(l))).size;
  if (added >= 10 && added > old.length) return true;
  if (!old.length) return false;
  const still = new Set(cur);
  return old.filter((l) => still.has(l)).length < old.length / 2;
}

/**
 * The most the reading waits for the page's content to settle, from the first wait on (the step's own limit
 * also bounds it): a page that never settles is read as it stands then.
 */
export const SETTLE_MAX_MS = 15_000;
/** Settled: the links in the main content unchanged for this long, and no data request in flight. */
export const SETTLE_STABLE_MS = 1000;
/** Quiet: no data request in flight, and none started or ended for this long. */
const QUIET_MS = 500;
const POLL_MS = 250;
/** The requests that bring a page's content: the page, its scripts and its data (not images, fonts, styles or media). */
const CONTENT_TYPES = new Set(["document", "script", "xhr", "fetch"]);

/**
 * The page's content requests in flight, from now on: `quiet()` is true when none is in flight and none
 * started or ended in the last QUIET_MS.
 */
export function watchRequests(p) {
  const inflight = new Set();
  let last = Date.now();
  const start = (r) => {
    if (!CONTENT_TYPES.has(r.resourceType())) return;
    inflight.add(r);
    last = Date.now();
  };
  const end = (r) => {
    if (inflight.delete(r)) last = Date.now();
  };
  p.on("request", start);
  p.on("requestfinished", end);
  p.on("requestfailed", end);
  return {
    quiet: () => inflight.size === 0 && Date.now() - last >= QUIET_MS,
    stop: () => {
      p.off("request", start);
      p.off("requestfinished", end);
      p.off("requestfailed", end);
    },
  };
}

/** Runs in the page: how many links its main content holds (in <main>, else the body, outside nav, header and footer). */
function mainLinks() {
  const root = document.querySelector("main") ?? document.body;
  if (!root) return 0;
  let n = 0;
  for (const a of root.querySelectorAll("a[href]")) if (!a.closest("nav, header, footer")) n++;
  return n;
}

/**
 * The capture's usual waits, shortened, a short scroll, then the reading once the content has settled (a list
 * drawn from data fetched after the page opened, alestor123.is-a.dev's repositories from a cold serverless
 * API): the links in the main content unchanged for SETTLE_STABLE_MS and no data request in flight, by
 * `until` at the latest. The usual waits are part of that window, so a page that has already settled is read
 * as soon as before. `report`, when given (tests), is filled with what the settling did: `changes`, how many times
 * the link count changed after the first reading; `polls`, how many polls it ran after the usual waits;
 * `busyPolls`, how many of those found a data request in flight. The reading is the same with or without it.
 */
export async function settleAndRead(p, net, { until = Date.now() + SETTLE_MAX_MS, report = null } = {}) {
  const left = () => until - Date.now();
  const stats = report ?? {};
  stats.changes = 0;
  stats.polls = 0;
  stats.busyPolls = 0;
  await p.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5000, left())) }).catch(() => {});
  let count = await p.evaluate(mainLinks).catch(() => -1);
  let changed = Date.now();
  const sample = async () => {
    const n = await p.evaluate(mainLinks).catch(() => count);
    if (n !== count) {
      count = n;
      changed = Date.now();
      stats.changes++;
    }
  };
  await p.waitForTimeout(Math.max(0, Math.min(1000, left())));
  await sample();
  for (let i = 0; i < 6 && left() > 0; i++) {
    await p.mouse.wheel(0, 1200).catch(() => {});
    await p.waitForTimeout(250);
    await sample();
  }
  while (left() > 0 && (Date.now() - changed < SETTLE_STABLE_MS || !net.quiet())) {
    stats.polls++;
    if (!net.quiet()) stats.busyPolls++;
    await p.waitForTimeout(Math.min(POLL_MS, Math.max(1, left())));
    await sample();
  }
  return p.evaluate(readRenderedPage);
}

/**
 * The site's own projects page (`url`, same host as `page`, the capture's
 * desktop page), read as described at the top. Returns { html, text,
 * finalUrl, via: "load" | "press" } or null. `page` is left on a blank page
 * when the limit passes during a press: the capture has taken everything
 * from it. Web sockets stay refused in the context afterwards (Playwright
 * has no way to lift that route), which matters to nothing: the capture only
 * writes after this step.
 */
export async function readProjectsPage(page, url, { limitMs = PROJECTS_PAGE_MS } = {}) {
  if (!sameHost(url, page.url())) return null;
  const ctx = page.context();
  let tab = null;
  let pressing = false;
  /** The request's page, or null (a worker's request has none). */
  const pageOf = (req) => {
    try {
      return req.frame().page();
    } catch {
      return null;
    }
  };
  const guard = (route) => {
    const req = route.request();
    const from = pageOf(req);
    // Only plain GETs, and only from the home page and our own tab: a popup's first load never leaves.
    const elsewhere = from ? from !== page && from !== tab : req.resourceType() === "document";
    if (req.method() !== "GET" || REFUSED_TYPES.has(req.resourceType()) || elsewhere) return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  };
  // Any window but our own tab (a popup from a script, a link with target=_blank) is closed at once.
  const onPage = (p) => {
    if (p !== tab) p.close().catch(() => {});
  };
  await ctx.route("**/*", guard);
  await ctx.routeWebSocket?.(/.*/, (ws) => ws.close()).catch(() => {});
  // Our own tab first, then the watch for any other window.
  tab = await ctx.newPage().catch(() => null);
  ctx.on("page", onPage);

  // The settling waits end in time for the reading, inside the step's limit.
  const until = Date.now() + Math.min(SETTLE_MAX_MS + 15000, limitMs - READ_RESERVE_MS);
  const settleBy = () => Math.min(until, Date.now() + SETTLE_MAX_MS);
  // The request watches (settleAndRead), stopped when the step ends.
  const watches = [];
  const watch = (p) => {
    const w = watchRequests(p);
    watches.push(w);
    return w;
  };
  const work = (async () => {
    const target = pathOf(url);
    // 1. A plain load of the link's address in a new tab. A hash route ("/#/projects") is a load of the home
    //    page's own address (the part after "#" is never sent), whose router then shows the route.
    if (!tab) return null;
    const net = watch(tab);
    const res = await tab.goto(url, { waitUntil: "load", timeout: 15000 }).catch(() => null);
    const status = res?.status() ?? 0;
    if (res && status < 400) {
      if (!sameHost(tab.url(), url)) return null; // redirected to another host
      const seen = await settleAndRead(tab, net, { until: settleBy() });
      return { html: seen.html, text: seen.text, finalUrl: tab.url(), via: "load" };
    }
    await tab.close().catch(() => {});
    tab = null;
    // 2. An error status: press the same-site link on the home page, unless a service worker controls it. Never
    //    for a hash route: its load was the home page itself.
    if (isHashRoute(url)) return null;
    if (await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)).catch(() => true)) return null;
    const before = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    pressing = true;
    const pageNet = watch(page);
    const pressed = await page
      .evaluate((p) => {
        const a = [...document.querySelectorAll("a[href]")].find((x) => x instanceof HTMLAnchorElement && x.origin === location.origin && x.pathname.replace(/\/+$/, "") === p);
        if (!a) return false;
        a.removeAttribute("target");
        a.click();
        return true;
      }, target)
      .catch(() => false);
    if (!pressed) return null;
    let arrived = false;
    for (let i = 0; i < 16 && !arrived; i++) {
      await page.waitForTimeout(500);
      if (!sameHost(page.url(), url)) return null;
      const now = await page.evaluate(() => document.body?.innerText ?? "").catch(() => before);
      arrived = pathOf(page.url()) === target || swapped(before, now);
    }
    if (!arrived || !sameHost(page.url(), url)) return null;
    const seen = await settleAndRead(page, pageNet, { until: settleBy() });
    // Its address as linked (an app that kept "/" in the address bar still showed this page).
    return { html: seen.html, text: seen.text, finalUrl: pathOf(page.url()) === target ? page.url() : new URL(url).href, via: "press" };
  })();

  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve("late"), limitMs)));
  try {
    const out = await Promise.race([work.catch(() => null), late]);
    if (out !== "late") return out;
    // Past the limit: stop what is still running, so nothing goes on after the step (the tab is
    // closed; the home page, when it was pressed, is sent to a blank page, which ends its scripts).
    await tab?.close().catch(() => {});
    if (pressing) await page.goto("about:blank", { timeout: 3000 }).catch(() => {});
    let t2;
    await Promise.race([work.catch(() => null), new Promise((r) => (t2 = setTimeout(r, 3000)))]);
    clearTimeout(t2);
    return null;
  } finally {
    clearTimeout(timer);
    for (const w of watches) w.stop();
    await tab?.close().catch(() => {});
    ctx.off("page", onPage);
    await ctx.unroute("**/*", guard).catch(() => {});
  }
}
