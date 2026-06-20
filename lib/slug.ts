import { randomBytes } from "crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Short, URL-safe, hard-to-guess id for shareable list slugs. 8 base-36 chars
 * ≈ 2.8e12 space — collisions are astronomically unlikely, and the unique
 * index on lists.slug is the backstop (callers retry on the rare clash).
 */
export function newSlug(len = 8): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
