// lib/json-ld.ts: the breadcrumb trail and the inline script body every
// public page's structured data uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { breadcrumbList, graph, jsonLdHtml } from "../lib/json-ld.ts";

test("a breadcrumb trail numbers its items from 1, in order, with absolute URLs", () => {
  const b = breadcrumbList([
    { name: "PortfolioRank", url: "https://portfoliorank.dev" },
    { name: "Blog", url: "https://portfoliorank.dev/blog" },
  ]);
  assert.equal(b["@type"], "BreadcrumbList");
  assert.deepEqual(b.itemListElement, [
    { "@type": "ListItem", position: 1, name: "PortfolioRank", item: "https://portfoliorank.dev" },
    { "@type": "ListItem", position: 2, name: "Blog", item: "https://portfoliorank.dev/blog" },
  ]);
});

test("a graph carries the schema.org context once", () => {
  assert.deepEqual(graph([{ "@type": "Thing" }]), { "@context": "https://schema.org", "@graph": [{ "@type": "Thing" }] });
});

test("the script body can't close its tag, and still parses to the same data", () => {
  const data = { name: "</script><script>alert(1)</script>" };
  const html = jsonLdHtml(data);
  assert.ok(!html.includes("<"));
  assert.deepEqual(JSON.parse(html), data);
});
