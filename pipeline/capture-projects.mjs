// Where a page's projects are when its home page does not link them (facts
// version 3, pipeline/facts.mjs): the destinations of project buttons that
// open a URL from script, and the site's own projects page. Both run on the
// capture's desktop page after everything stored from it was taken (the
// readings, the screenshots), each under a hard time limit; a failure or a
// timeout adds nothing and never fails the capture. Nothing here is stored
// except the URLs they find, and nothing is uploaded.
import { readRenderedPage } from "./gate.mjs";
import { PROJECT_ATTR, PROJECT_HEADING } from "./page-controls.mjs";

/** An element, or the heading above it, that holds projects (as the scanner reads them, ./page-controls.mjs). */
const PROJECT_SECTION = new RegExp(`${PROJECT_ATTR.source}|${PROJECT_HEADING.source}`, "i");
/** A button label that opens something: "Visit Website", "View on PyPI", "Live demo", "VS Code Marketplace", "Source code". */
const PROJECT_DESTINATION = /\b(?:visit|view|open|launch|live|demo|preview|try|source|code|github|repo(?:sitory)?|marketplace|pub\.dev|pypi|npm|app store|play store|website|site)\b/i;

/** The most a button probe and a projects page may take, well inside the capture's SITE_LIMIT_MS (5 minutes). */
export const BUTTON_PROBE_MS = 10_000;
export const PROJECTS_PAGE_MS = 25_000;
/** At most this many project buttons are pressed. */
export const MAX_PROJECT_BUTTONS = 12;

/** `work` within `ms`, else `fallback` (the work is left to finish or fail on its own). */
async function within(work, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs in the page: marks the buttons in the projects whose label says they
 * open something ("Visit Website", "View on PyPI", "Live demo", "VS Code
 * Marketplace") and are not in a link, so their handler is the only way to
 * their destination. Returns how many were marked.
 */
function markProjectButtons({ max, project, destination }) {
  const projectRe = new RegExp(project, "i");
  const destRe = new RegExp(destination, "i");
  const words = (el) => `${el.id ?? ""} ${el.getAttribute?.("class") ?? ""} ${el.getAttribute?.("aria-label") ?? ""}`.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
  const headings = [...document.querySelectorAll("h1,h2,h3")];
  const inProjects = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (/^(NAV|HEADER|FOOTER)$/.test(a.tagName)) return false;
      if (projectRe.test(words(a))) return true;
    }
    // The nearest h1-h3 above it names the projects.
    let above = null;
    for (const h of headings) if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) above = h;
    return Boolean(above && projectRe.test(above.innerText || ""));
  };
  let n = 0;
  for (const el of document.querySelectorAll("button, [role=button]")) {
    if (n >= max) break;
    if (el.closest("a[href]") || el.disabled) continue;
    const label = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.replace(/\s+/g, " ").trim();
    if (!label || label.length > 60 || !destRe.test(label) || !inProjects(el)) continue;
    el.setAttribute("data-pr-probe", String(n++));
  }
  return n;
}

/** Runs in the page: presses one marked button with window.open recorded instead of obeyed. */
function pressProjectButton(i) {
  const opened = [];
  const real = window.open;
  window.open = (u) => {
    if (u) opened.push(String(u));
    return null;
  };
  const before = location.href;
  try {
    document.querySelector(`[data-pr-probe="${i}"]`)?.click();
  } finally {
    window.open = real;
  }
  return { opened, moved: location.href !== before ? location.href : null };
}

/**
 * The URLs a page's project buttons open from script (nitishkr.fun's "VS Code
 * Marketplace" and "View on PyPI" buttons call window.open from a React
 * handler, so no URL is in the page). Each marked button is pressed once with
 * window.open recorded instead of obeyed and every page load of the main
 * frame refused (its URL is recorded); a route change inside the page is
 * recorded and gone back from. A button that opens a dialog adds nothing.
 * `patterns` are the projects and destination patterns as regex sources.
 */
export async function readProjectButtons(page, { limitMs = BUTTON_PROBE_MS, max = MAX_PROJECT_BUTTONS } = {}) {
  const found = [];
  const start = page.url().replace(/#.*$/, "");
  let stopped = false;
  const refuse = (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      found.push(req.url());
      // 204 No Content: the browser stays on the page (an aborted load would leave an error page).
      return route.fulfill({ status: 204, body: "" });
    }
    return route.continue();
  };
  const work = (async () => {
    const n = await page.evaluate(markProjectButtons, { max, project: PROJECT_SECTION.source, destination: PROJECT_DESTINATION.source });
    if (!n) return;
    const home = page.url();
    await page.route("**/*", refuse);
    for (let i = 0; i < n && !stopped; i++) {
      const r = await page.evaluate(pressProjectButton, i).catch(() => null);
      if (r) found.push(...r.opened, ...(r.moved ? [r.moved] : []));
      await page.waitForTimeout(250);
      await page.keyboard.press("Escape").catch(() => {});
      if (page.url() !== home) await page.goBack({ timeout: 3000 }).catch(() => {});
    }
  })();
  try {
    await within(work, limitMs, undefined);
  } finally {
    stopped = true;
    await page.unroute("**/*", refuse).catch(() => {});
  }
  const home = page.url().replace(/#.*$/, "");
  // The page itself (going back to it after a route change) is not a destination.
  return [...new Set(found.filter((u) => /^https?:\/\//i.test(u) && u.replace(/#.*$/, "") !== home && u.replace(/#.*$/, "") !== start))];
}

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

const sameHost = (a, b) => {
  try {
    return new URL(a).hostname.replace(/^www\./, "").toLowerCase() === new URL(b).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
};

/**
 * The site's own projects page (`url`, same host as the page), read on the
 * capture's desktop page: by pressing the link to it when the page has one
 * (a single-page app routes there without a page load, and a page served
 * only through its app's router, as on GitHub Pages, answers 404 when loaded
 * directly), else by loading it. Then the capture's usual waits, shortened,
 * and a short scroll. Returns { html, text, finalUrl } or null: another host,
 * an error status, a timeout or any failure adds nothing.
 */
export async function readProjectsPage(page, url, { limitMs = PROJECTS_PAGE_MS } = {}) {
  if (!sameHost(url, page.url())) return null;
  let status = null;
  const onResponse = (r) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status();
  };
  page.on("response", onResponse);
  const work = (async () => {
    const target = new URL(url);
    const path = target.pathname.replace(/\/+$/, "");
    const at = () => new URL(page.url()).pathname.replace(/\/+$/, "") === path;
    const before = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const pressed = await page
      .evaluate((p) => {
        const a = [...document.querySelectorAll("a[href]")].find((x) => x.origin === location.origin && x.pathname.replace(/\/+$/, "") === p);
        if (!a) return false;
        a.removeAttribute("target");
        a.click();
        return true;
      }, path)
      .catch(() => false);
    // Arrived: the address changed, or the app swapped the page's content without changing it (eduardconstantin.github.io).
    let arrived = false;
    if (pressed) {
      for (let i = 0; i < 16 && !arrived; i++) {
        await page.waitForTimeout(500);
        const now = await page.evaluate(() => document.body?.innerText ?? "").catch(() => before);
        arrived = at() || swapped(before, now);
      }
    }
    if (!arrived) await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.waitForTimeout(250);
    }
    if (status != null && status >= 400) return null;
    if (!sameHost(page.url(), url)) return null;
    const seen = await page.evaluate(readRenderedPage);
    // Its address as linked (an app that kept "/" in the address bar still showed this page).
    return { html: seen.html, text: seen.text, finalUrl: at() ? page.url() : target.href };
  })();
  try {
    return await within(work, limitMs, null);
  } finally {
    page.off("response", onResponse);
  }
}
