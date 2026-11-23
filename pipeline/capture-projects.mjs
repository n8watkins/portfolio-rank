// The site's own projects page, for a home page that shows fewer than 3
// projects (facts version 3, pipeline/facts.mjs projectsPageFor). It runs
// once per capture, after everything stored from the capture was taken (the
// readings and every screenshot), in the capture's own browser context, and
// it is only ever a plain GET of an <a href> on the same host:
//
//   1. load the link's address in a new tab;
//   2. only when that answers an error status (an app served only through its
//      router answers 404 to a direct load, as eduardconstantin.github.io on
//      GitHub Pages does), press that same-site link on the home page, so
//      its router shows the page; never when a service worker controls the
//      page, since its requests would bypass the guard below.
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

/** The capture's usual waits, shortened, a short scroll, then the reading. */
async function settleAndRead(p) {
  await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(1000);
  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, 1200).catch(() => {});
    await p.waitForTimeout(250);
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

  const work = (async () => {
    const target = pathOf(url);
    // 1. A plain load of the link's address in a new tab.
    if (!tab) return null;
    const res = await tab.goto(url, { waitUntil: "load", timeout: 15000 }).catch(() => null);
    const status = res?.status() ?? 0;
    if (res && status < 400) {
      if (!sameHost(tab.url(), url)) return null; // redirected to another host
      const seen = await settleAndRead(tab);
      return { html: seen.html, text: seen.text, finalUrl: tab.url(), via: "load" };
    }
    await tab.close().catch(() => {});
    tab = null;
    // 2. An error status: press the same-site link on the home page, unless a service worker controls it.
    if (await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)).catch(() => true)) return null;
    const before = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    pressing = true;
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
    const seen = await settleAndRead(page);
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
    await tab?.close().catch(() => {});
    ctx.off("page", onPage);
    await ctx.unroute("**/*", guard).catch(() => {});
  }
}
