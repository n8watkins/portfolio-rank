// The preview render: the HTML the owner reviews a draft in (the admin view
// and the sample pages), not the blog page. Compact reading: 1.55 line
// height and small paragraph gaps, images at about 60% width, centred, with
// captions (full width on phones), and the fact sheet folded into a
// collapsed "Show the data" section that scrolls at 320px. Light and dark.
// Pure: no I/O; `imageSrc(image)` says where each image is served from.

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const inline = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

export const PREVIEW_CSS = `
:root{--bg:#fff;--fg:#1b1b1f;--muted:#5f6068;--line:#dcdce0;--card:#f6f6f8;--accent:#b45309;--callout:#fffbeb;--link:#1d4ed8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121214;--fg:#ececf0;--muted:#a0a1aa;--line:#34353b;--card:#1b1b1f;--accent:#fbbf24;--callout:#2a2412;--link:#8ab4ff}}
:root[data-theme="dark"]{--bg:#121214;--fg:#ececf0;--muted:#a0a1aa;--line:#34353b;--card:#1b1b1f;--accent:#fbbf24;--callout:#2a2412;--link:#8ab4ff}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:28px;line-height:1.2;margin:.4rem 0}
h3{font-size:19px;line-height:1.3;margin:1.4rem 0 .4rem}
p{margin:0 0 .65rem}
a{color:var(--link)}
.status{display:inline-block;padding:2px 8px;border-radius:99px;background:var(--card);border:1px solid var(--line);font-size:12px;color:var(--muted)}
.meta,.ai,figcaption{font-size:13px;color:var(--muted)}
.sub{font-style:italic;color:var(--muted);margin:0 0 .8rem}
figure{margin:1rem auto;width:60%;text-align:center}
figure img{width:100%;height:auto;border-radius:8px;border:1px solid var(--line);background:var(--card)}
figcaption{margin-top:.3rem}
blockquote{border-left:3px solid var(--accent);margin:.9rem 0;padding:.25rem 1rem;background:var(--callout)}
blockquote p{margin:.2rem 0}
ol,ul{margin:.3rem 0 .7rem;padding-left:1.4rem}
li{margin:.15rem 0}
details{margin:1.4rem 0;border:1px solid var(--line);border-radius:8px;background:var(--card)}
summary{cursor:pointer;padding:.6rem .9rem;font-weight:600}
details .scroll{max-height:320px;overflow:auto;padding:0 .9rem .8rem}
table{border-collapse:collapse;font-size:13px;width:100%}
td,th{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}
@media (max-width:640px){figure{width:100%}h1{font-size:24px}}
`;

/** The body's Markdown as HTML: sentences of a paragraph (one per line) join into one <p>. */
export function bodyHtml(body, images = new Map()) {
  const out = [];
  let list = null;
  let quote = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join(" ")}</p>`);
    para = [];
    if (list) out.push(`</${list}>`);
    list = null;
    if (quote.length) out.push(`<blockquote>${quote.join("")}</blockquote>`);
    quote = [];
  };
  for (const l of String(body).split("\n")) {
    const img = l.match(/^\[\[image:([a-z0-9-]+)\]\]$/);
    if (img) {
      flush();
      out.push(images.get(img[1]) ?? "");
    } else if (/^### /.test(l)) {
      flush();
      out.push(`<h3>${inline(l.slice(4))}</h3>`);
    } else if (/^>/.test(l)) {
      if (para.length || list) flush();
      const t = l.replace(/^>\s?/, "");
      quote.push(/^- /.test(t) ? `<li>${inline(t.slice(2))}</li>` : `<p>${inline(t)}</p>`);
    } else if (/^\d+\.\s/.test(l)) {
      if (para.length || quote.length) flush();
      if (list !== "ol") (list = "ol"), out.push("<ol>");
      out.push(`<li>${inline(l.replace(/^\d+\.\s/, ""))}</li>`);
    } else if (!l.trim()) flush();
    else {
      if (list || quote.length) flush();
      para.push(l);
    }
  }
  flush();
  return out.join("\n");
}

/** The fact sheet as a collapsed section that scrolls. */
export function dataHtml(post) {
  const facts = post.facts?.facts ?? [];
  const rows = facts.map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(f.label)}</td><td>${esc(f.display)}</td><td>${esc(f.tone)}</td><td>${esc(f.about ?? "")}</td></tr>`).join("");
  const names = (post.facts?.names ?? []).map((x) => `${esc(x.name)} (${esc(x.reason)})`).join(", ") || "none";
  return `<details class="data"><summary>Show the data</summary><div class="scroll"><p class="meta">Data as of ${esc(post.dataAsOf)}. Query: ${esc(facts[0]?.query)}<br>Names allowed: ${names}</p><table><tr><th>id</th><th>label</th><th>display</th><th>tone</th><th>about</th></tr>${rows}</table></div></details>`;
}

export function figureHtml(im, src) {
  const credit = im.creditUrl ? `<a href="${esc(im.creditUrl)}">${esc(im.credit)}</a>` : esc(im.credit);
  return `<figure><img src="${esc(src)}" alt="${esc(im.alt)}"><figcaption>${esc(im.alt)}<br>${credit} - ${esc(im.kind)}, ${esc(im.licence)}</figcaption></figure>`;
}

/**
 * A whole preview page for a stored post. `imageSrc(image)` returns the
 * src of an image; `banner` is an optional line shown first (for example the
 * failing check of a draft that did not pass).
 */
export function renderPreview(post, { imageSrc = (im) => im.url, banner = "" } = {}) {
  const images = new Map(post.images.map((im) => [im.slot, figureHtml(im, imageSrc(im))]));
  const checks = (post.checks?.history ?? []).flatMap((h) => h.checks.map((c) => `<tr><td>${h.round}</td><td>${esc(c.name)}</td><td>${c.ok ? "pass" : "fail"}</td><td>${esc(c.problems.join("; "))}</td></tr>`));
  const cut = (post.checks?.history ?? []).flatMap((h) => h.claims.cut.map((c) => `<li>${esc(c.sentence)} <em>(${esc(c.reason)})</em></li>`));
  const kept = (post.claims ?? []).map((c) => `<li>${esc(c.sentence)} - <a href="${esc(c.url)}">source</a></li>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(post.title)}</title><style>${PREVIEW_CSS}</style></head><body><main>
${banner ? `<p class="banner"><strong>${esc(banner)}</strong></p>` : ""}
<p class="status">${esc(post.status)} - ${esc(post.kind)} - ${post.requests} Gemini requests - would publish ${esc(post.publishAt ?? "-")}</p>
<h1>${esc(post.title)}</h1>
<p class="ai">${esc(post.aiLine)}</p>
<p class="sub">${esc(post.subtitle)}</p>
<p class="meta">Alt titles: ${post.altTitles.map(esc).join(" | ")}<br>Tags: ${post.tags.map(esc).join(", ")}<br>Share line: ${esc(post.shareLine)}<br>Newsletter: ${esc(post.newsletterBlurb)}</p>
${bodyHtml(post.body, images)}
<hr><p class="ai">${esc(post.aiNote).replace(/\n/g, "<br>")}</p>
${dataHtml(post)}
<details><summary>Checks</summary><div class="scroll"><p>Passed: ${post.checks?.passed} after ${post.checks?.rounds} round(s).${post.checks?.failures?.length ? ` Failures: ${esc(post.checks.failures.join("; "))}` : ""}</p>
<table><tr><th>round</th><th>check</th><th>result</th><th>problems</th></tr>${checks.join("")}</table>
${cut.length ? `<p>Outside claims cut</p><ul>${cut.join("")}</ul>` : "<p>No outside claims were cut.</p>"}
${kept.length ? `<p>Outside claims kept</p><ul>${kept.join("")}</ul>` : ""}</div></details>
</main></body></html>`;
}
