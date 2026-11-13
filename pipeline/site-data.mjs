// The untrusted-data block every Gemini prompt puts site content in
// (pipeline/rubric.mjs, pipeline/compare-prompts.mjs, pipeline/judge.mjs).
// Text copied from a website (its name, page text) goes between <site_data>
// and </site_data>, and the system instruction tells the model never to obey
// it. Anything in that text that looks like a marker, an opening one with
// attributes included (<site_data label="B">), is removed first, so a page
// can never close its block early or forge another site's block.

/** Every spelling of an opening or closing site_data tag, attributes included, even one left unclosed. */
export const SITE_DATA_MARKER = /<\s*\/?\s*site_data\b[^>]*>?/gi;

import { redactContacts } from "./redact.mjs";

/** `text` with every site_data marker replaced by a space. */
export const stripSiteDataMarkers = (text) => String(text ?? "").replace(SITE_DATA_MARKER, " ");

/** A block with a site's name only (the legacy pairwise vote, pipeline/judge.mjs). */
export const siteNameBlock = (label, name) =>
  `<site_data label="${label}">\nname: ${redactContacts(stripSiteDataMarkers(name).slice(0, 80))}\n</site_data>`;
