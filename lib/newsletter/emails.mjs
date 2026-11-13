// A new post's newsletter email, as the HTML of a Kit broadcast
// (lib/newsletter/kit.mjs). Plain HTML that works without images or CSS
// support (tables, inline styles, one column, 560 px). Kit fills in the
// Liquid tags in the footer: {{ unsubscribe_url }} (Kit's one-click
// unsubscribe, which it also puts in the List-Unsubscribe header) and
// {{ address }} (the sender's mailing address, which the law asks for).
// Kit makes the text version itself.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INK = "#111114";
const MUTE = "#5b5b66";
const FAINT = "#7a7a85";
const EDGE = "#e4e4e7";
const ACCENT = "#f5a524";

function layout({ preheader, body, footer }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>PortfolioRank</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px">
<tr><td style="padding:0 4px 14px;font-size:15px;font-weight:700;letter-spacing:-0.01em;color:${INK}"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${ACCENT};margin-right:8px;vertical-align:middle"></span>PortfolioRank</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${EDGE};border-radius:14px;overflow:hidden">${body}</td></tr>
<tr><td style="padding:18px 6px 0;font-size:12px;line-height:1.6;color:${FAINT}">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<a href="${esc(href)}" style="display:inline-block;background:${ACCENT};color:${INK};font-weight:600;font-size:15px;text-decoration:none;padding:12px 20px;border-radius:10px">${esc(label)}</a>`;

/** Kit's own tags, filled in per subscriber when the broadcast goes out. */
export const KIT_UNSUBSCRIBE = "{{ unsubscribe_url }}";
export const KIT_ADDRESS = "{{ address }}";

/**
 * A new post: title, a short summary, an optional cover image, a link to the
 * post, and the footer with Kit's unsubscribe link and mailing address. The
 * admin's preview passes "#" and a placeholder address instead of the tags.
 * @param {{ title: string, summary: string | null, url: string, image?: string | null, imageAlt?: string, site: string, unsubscribeUrl?: string, address?: string }} p
 */
export function postEmail({ title, summary, url, image = null, imageAlt = "", site, unsubscribeUrl = KIT_UNSUBSCRIBE, address = KIT_ADDRESS }) {
  const host = site.replace(/^https?:\/\//, "");
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${image ? `<tr><td style="padding:0;background:#0a0a0b"><a href="${esc(url)}"><img src="${esc(image)}" alt="${esc(imageAlt)}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:26px 28px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#b7791f">New on the blog</td></tr>
<tr><td style="padding:8px 28px 0;font-size:23px;font-weight:700;line-height:1.25;letter-spacing:-0.01em"><a href="${esc(url)}" style="color:${INK};text-decoration:none">${esc(title)}</a></td></tr>
${summary ? `<tr><td style="padding:12px 28px 0;font-size:16px;line-height:1.6;color:${MUTE}">${esc(summary)}</td></tr>` : ""}
<tr><td style="padding:22px 28px 28px">${button(url, "Read the post")}</td></tr>
</table>`;
  // The unsubscribe link and the address go in as they are: Kit's Liquid tags, never user text.
  const footer = `You get this because you subscribed to PortfolioRank's blog at <a href="${esc(site)}" style="color:${FAINT}">${esc(host)}</a>. One email a post, at most two a week.<br><a href="${unsubscribeUrl}" style="color:${FAINT};text-decoration:underline">Unsubscribe</a><br>${address}`;
  return { subject: title, previewText: summary ?? title, html: layout({ preheader: summary ?? title, body, footer }) };
}
