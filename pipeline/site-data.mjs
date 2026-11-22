// The untrusted-data block every Gemini prompt puts site content in
// (pipeline/rubric.mjs, pipeline/compare-prompts.mjs).
// Text copied from a website (its name, page text) goes between <site_data>
// and </site_data>, and the system instruction tells the model never to obey
// it. Anything in that text that looks like a marker, an opening one with
// attributes included (<site_data label="B">), is removed first, so a page
// can never close its block early or forge another site's block.

/** Every spelling of an opening or closing site_data tag, attributes included, even one left unclosed. */
export const SITE_DATA_MARKER = /<\s*\/?\s*site_data\b[^>]*>?/gi;

/** `text` with every site_data marker replaced by a space. */
export const stripSiteDataMarkers = (text) => String(text ?? "").replace(SITE_DATA_MARKER, " ");
