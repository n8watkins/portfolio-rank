// The newsletter's two emails, as { subject, text, html, headers? }: the
// confirm-your-address email and a new post. Plain HTML that works without
// images or CSS support (tables, inline styles, one column, 560 px), and a
// text version with the same words. The post email carries a one-click
// unsubscribe (List-Unsubscribe and List-Unsubscribe-Post, RFC 8058) and the
// same link in its footer.

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

/** "Confirm your subscription": the only email an unconfirmed address ever gets. */
export function confirmEmail({ link, site }) {
  const subject = "Confirm your PortfolioRank subscription";
  const text = `Confirm your subscription to PortfolioRank's blog:\n\n${link}\n\nYou'll get an email when a new post goes up, at most two a week. The link works for 3 days.\n\nIf you didn't sign up, ignore this email: nothing happens without the link, and we delete the address in 7 days.\n\n${site}\n`;
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:28px 28px 6px;font-size:21px;font-weight:700;line-height:1.3">Confirm your subscription</td></tr>
<tr><td style="padding:0 28px 22px;font-size:15px;line-height:1.6;color:${MUTE}">Press the button to get PortfolioRank's new blog posts by email, at most two a week. The link works for 3 days.</td></tr>
<tr><td style="padding:0 28px 28px">${button(link, "Confirm my subscription")}</td></tr>
</table>`;
  const footer = `If you didn't sign up, ignore this email: nothing happens without the button, and we delete the address in 7 days.<br><a href="${esc(site)}" style="color:${FAINT}">${esc(site.replace(/^https?:\/\//, ""))}</a>`;
  return { subject, text, html: layout({ preheader: "One click to confirm, then a short email when a new post goes up.", body, footer }) };
}

/**
 * A new post: title, a short summary, an optional cover image, a link to the
 * post and the unsubscribe link (also as headers).
 * @param {{ title: string, summary: string | null, url: string, image?: string | null, imageAlt?: string, unsubscribeUrl: string, site: string, test?: boolean }} p
 */
export function postEmail({ title, summary, url, image = null, imageAlt = "", unsubscribeUrl, site, test = false }) {
  const subject = `${test ? "[Test] " : ""}${title}`;
  const host = site.replace(/^https?:\/\//, "");
  const text = [
    test ? "This is a test of the newsletter email. Subscribers get the same email without this line.\n" : null,
    "New on the PortfolioRank blog",
    "",
    title,
    summary ? `\n${summary}` : null,
    "",
    `Read it: ${url}`,
    "",
    "--",
    `You get this because you subscribed to PortfolioRank's blog at ${host}.`,
    `Unsubscribe in one click: ${unsubscribeUrl}`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${test ? `<tr><td style="padding:12px 28px;background:#fff7e6;border-bottom:1px solid ${EDGE};font-size:13px;color:${MUTE}">Test email: subscribers get the same email without this line.</td></tr>` : ""}
${image ? `<tr><td style="padding:0;background:#0a0a0b"><a href="${esc(url)}"><img src="${esc(image)}" alt="${esc(imageAlt)}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:26px 28px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#b7791f">New on the blog</td></tr>
<tr><td style="padding:8px 28px 0;font-size:23px;font-weight:700;line-height:1.25;letter-spacing:-0.01em"><a href="${esc(url)}" style="color:${INK};text-decoration:none">${esc(title)}</a></td></tr>
${summary ? `<tr><td style="padding:12px 28px 0;font-size:16px;line-height:1.6;color:${MUTE}">${esc(summary)}</td></tr>` : ""}
<tr><td style="padding:22px 28px 28px">${button(url, "Read the post")}</td></tr>
</table>`;
  const footer = `You get this because you subscribed to PortfolioRank's blog at <a href="${esc(site)}" style="color:${FAINT}">${esc(host)}</a>. One email a post, at most two a week.<br><a href="${esc(unsubscribeUrl)}" style="color:${FAINT};text-decoration:underline">Unsubscribe</a>`;
  return {
    subject,
    text,
    html: layout({ preheader: summary ?? title, body, footer }),
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
