// Contact details never reach Gemini (pipeline/redact.mjs): page text and
// names become [email] / [phone] tokens before any prompt is built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPhone, redactContacts } from "../pipeline/redact.mjs";
import { buildRubricRequest } from "../pipeline/rubric.mjs";
import { buildPairRequest, buildBatchRequest } from "../pipeline/compare-prompts.mjs";

const cases = [
  ["Email me: jane.doe+work@mail.example.co.uk today", "Email me: [email] today"],
  ["HELLO@EXAMPLE.DEV", "[email]"],
  ["<a>mailto:a@b.io?subject=hi</a>", "<a>[email]</a>"],
  ["tel:+15551234567", "[phone]"],
  ["jane [at] example [dot] com", "[email]"],
  ["jane(at)example.com", "[email]"],
  ["jane {at} example . io", "[email]"],
  ["jane at example dot com", "[email]"],
  ["US +1 (415) 555-0132", "US [phone]"],
  ["UK +44 20 7946 0958", "UK [phone]"],
  ["DE +49 30 901820", "DE [phone]"],
  ["FR +33 6 12 34 56 78", "FR [phone]"],
  ["IN +91-98765-43210", "IN [phone]"],
  ["AU 0412 345 678", "AU [phone]"],
  ["UK (020) 7946 0958", "UK [phone]"],
  ["call 415.555.0132, office 555-0199.", "call [phone], office [phone]."],
  ["digits 4155550132 here", "digits [phone] here"],
];

for (const [input, expected] of cases) {
  test(`redacts ${JSON.stringify(input)}`, () => {
    assert.equal(redactContacts(input), expected);
  });
}

const kept = [
  "Worked 2019 - 2024 and 2015-2018",
  "Timeline: 2018 2019 2020 2021",
  "born 1990-05-04, released 2026.11.10",
  "v3.5.1 and Node 20.11.1",
  "Over 1200 users and 35000 stars",
  "We sat at the table and looked at examples",
  "Follow @janedoe on GitHub",
  "https://example.com/a/b?id=12345",
  "Score: 98/100",
];
for (const text of kept) {
  test(`keeps ${JSON.stringify(text)}`, () => {
    assert.equal(redactContacts(text), text);
  });
}

test("isPhone: numbers of 7 to 15 digits in phone shapes only", () => {
  assert.equal(isPhone("555-0199"), true);
  assert.equal(isPhone("+44 20 7946 0958"), true);
  assert.equal(isPhone("123456"), false);
  assert.equal(isPhone("2019 - 2024"), false);
  assert.equal(isPhone("+1234567890123456"), false);
});

test("the grading request never contains the contact values", () => {
  const { parts } = buildRubricRequest({
    name: "Jane (jane@example.com)",
    url: "https://jane.dev",
    pageText: "Hi, I'm Jane. Write to jane@example.com or call +1 (415) 555-0132. mailto:jane@example.com",
    facts: { contact: true },
  });
  const text = parts.map((p) => p.text ?? "").join("\n");
  assert.doesNotMatch(text, /jane@example\.com|555-0132/);
  assert.match(text, /Write to \[email\] or call \[phone\]/);
  assert.match(text, /contact path: yes/);
});

test("comparison requests never contain the contact values", () => {
  const image = { inline_data: { mime_type: "image/jpeg", data: "" } };
  const site = (n) => ({ name: `Site ${n}`, pageText: `Contact ${n}@example.com or +44 20 7946 095${n}`, image });
  const texts = [buildPairRequest([site(1), site(2)]), buildBatchRequest([site(1), site(2), site(3)])].map((r) => r.parts.map((p) => p.text ?? "").join("\n"));
  for (const t of texts) {
    assert.doesNotMatch(t, /@example\.com|7946/);
    assert.match(t, /Contact \[email\] or \[phone\]/);
  }
});
