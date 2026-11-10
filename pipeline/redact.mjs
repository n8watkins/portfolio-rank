// Contact details never reach Gemini (owner decision 2026-11-10): before any
// page text goes into a prompt, email addresses and phone numbers (and
// mailto:/tel: links) become the neutral tokens [email] and [phone].
// Whether a site has a contact path is a fact measured by code from the
// page's links (pipeline/facts.mjs), so the model loses nothing it needs;
// it just never sees the values. The free tier's terms ask not to send
// personal information (docs/ASSUMPTIONS.md A9).

export const EMAIL_TOKEN = "[email]";
export const PHONE_TOKEN = "[phone]";

const MAILTO = /\bmailto:[^\s"'<>)\]]*/gi;
const TEL = /\b(?:tel|callto|sms):[^\s"'<>)\]]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// "jane [at] example [dot] com", "jane(at)example.com", "jane {at} example . com"
const BRACKETED_AT = /\b[\w.+-]+\s*[[({<]\s*at\s*[\])}>]\s*[\w-]+(?:\s*(?:[[({<]\s*dot\s*[\])}>]|\.)\s*[\w-]+)+/gi;
// "jane at example dot com": the plain spelled-out form needs a " dot ".
const PLAIN_AT = /\b[\w.+-]+\s+at\s+[\w-]+(?:\s+dot\s+[\w-]+)+\b/gi;
// A run of digits with phone separators; checked by isPhone before it is replaced.
const PHONE_CANDIDATE = /(?<![\w.@/+-])(?:\+\s?)?\(?\d[\d\s().-]{5,}\d(?![\w@])/g;

const YEAR_RANGE = /^(?:19|20)\d\d\s*[-.]\s*(?:19|20)?\d\d$/;
const DATE = /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}$/;

/** True when a candidate run of digits reads as a phone number rather than a year range, a date or a version. */
export function isPhone(candidate) {
  const s = candidate.trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  if (YEAR_RANGE.test(s) || DATE.test(s)) return false;
  // A run of years ("2018 2019 2020") is a timeline, not a number.
  const groups = s.split(/\D+/).filter(Boolean);
  if (groups.length > 1 && groups.every((g) => /^(?:19|20)\d\d$/.test(g))) return false;
  if (s.startsWith("+")) return digits.length >= 8;
  // Local formats without a country code: 555-1234 and longer.
  if (/^\(?\d{3}\)?[\s.-]\d{3,4}(?:[\s.-]\d{3,4})?$/.test(s)) return true;
  if (/^\(\d{2,5}\)\s?\d/.test(s)) return true;
  return digits.length >= 10;
}

/** The text with email addresses, phone numbers and mailto:/tel: links replaced by [email] and [phone]. */
export function redactContacts(text) {
  return String(text ?? "")
    .replace(MAILTO, EMAIL_TOKEN)
    .replace(TEL, PHONE_TOKEN)
    .replace(EMAIL, EMAIL_TOKEN)
    .replace(BRACKETED_AT, EMAIL_TOKEN)
    .replace(PLAIN_AT, EMAIL_TOKEN)
    .replace(PHONE_CANDIDATE, (m) => {
      // Keep the separator the match started or ended with, if any.
      const lead = m.match(/^\s*/)[0];
      const trail = m.match(/\s*$/)[0];
      return isPhone(m) ? `${lead}${PHONE_TOKEN}${trail}` : m;
    });
}
