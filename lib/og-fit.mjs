// Fitting text into the share card (lib/og-portfolio.tsx). Satori neither
// measures nor balances text, so the card estimates widths from Inter's
// average glyph width and lays the lines out itself. Plain JavaScript so the
// unit tests (tests/og-fit.test.mjs) can import it.

/** A friendly lower bound for a count: 1,370 gives "1,300+", 2,046 gives "2,000+", 87 gives "80+". */
export function friendlyCount(n) {
  const step = n >= 1000 ? 100 : n >= 100 ? 10 : 1;
  const down = Math.floor(n / step) * step;
  return `${down.toLocaleString("en-US")}${down < n ? "+" : ""}`;
}

/** The biggest font size (min..max) at which `text` fits `lines` lines of `width`, from the average glyph width `em`. */
export function fitSize(text, width, { max, min, em, lines = 1 }) {
  const fit = Math.floor((lines * width) / Math.max(1, String(text).length * em));
  return Math.max(min, Math.min(max, fit));
}

/** Inter ExtraBold's average glyph width, as a share of the font size (measured about 0.545; a little generous, so estimates err towards fitting). */
const NAME_EM = 0.56;
const NAME_MAX = 72;
const NAME_TWO_LINE_MAX = 60;
export const NAME_MIN = 38;

/** Breakable pieces of a name: words, and the parts of hyphenated words (the hyphen stays on the left part). */
function pieces(name) {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => w.split(/(?<=-)/));
}

/** Greedy wrap of `parts` into lines of at most `chars` characters; null when it needs more than `maxLines` or a part alone is too long. */
function wrap(parts, chars, maxLines) {
  const lines = [];
  let line = "";
  for (const p of parts) {
    if (p.length > chars) return null;
    const joined = line ? (line.endsWith("-") ? line + p : `${line} ${p}`) : p;
    if (joined.length <= chars) line = joined;
    else {
      lines.push(line);
      line = p;
      if (lines.length >= maxLines) return null;
    }
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

/**
 * How a name sits in the card's name column (owner, 2026-11-12): one line at
 * full size when it fits, else two lines, shrinking from 60px to 38px; only
 * then shortened, and never mid-word: first the middle names go ("Maria
 * Elena Garcia Lopez" gives "Maria Lopez"), then trailing words; only a
 * single word too long for two lines is cut, with an ellipsis.
 * @param {string} name
 * @param {number} width the column's width in pixels
 * @returns {{ lines: string[], size: number }}
 */
export function fitName(name, width) {
  const chars = (size) => Math.floor(width / (size * NAME_EM));
  const tryFit = (text) => {
    const parts = pieces(text);
    for (let size = NAME_MAX; size >= NAME_MIN; size -= 2) {
      const lines = wrap(parts, chars(size), size > NAME_TWO_LINE_MAX ? 1 : 2);
      if (lines) return { lines, size };
    }
    return null;
  };
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const fitted = tryFit(words.join(" "));
  if (fitted) return fitted;
  if (words.length > 2) {
    const firstLast = tryFit(`${words[0]} ${words[words.length - 1]}`);
    if (firstLast) return firstLast;
  }
  for (let n = words.length - 1; n >= 1; n--) {
    const head = tryFit(words.slice(0, n).join(" "));
    if (head) return head;
  }
  // One word longer than two lines at the smallest size: the last resort.
  const per = chars(NAME_MIN);
  const word = words[0] ?? "";
  return { lines: [word.slice(0, per), `${word.slice(per, 2 * per - 1)}…`], size: NAME_MIN };
}
