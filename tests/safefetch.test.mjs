// The address checks in front of every fetch of a portfolio site (lib/safefetch.ts).
// Node strips the TypeScript types itself, so the module is imported as is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicHttpUrl } from "../lib/safefetch.ts";

test("private, loopback, metadata and reserved addresses are refused", () => {
  for (const url of [
    "http://localhost/",
    "http://localhost./",
    "http://app.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://router.home.arpa/",
    "http://0.0.0.0/",
    "http://0.1.2.3/",
    "http://127.0.0.1/",
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f.1/", // hex
    "http://017700000001/", // octal
    "http://10.1.2.3/",
    "http://100.64.0.1/",
    "http://100.127.255.255/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.0.0.8/",
    "http://192.168.1.1/",
    "http://198.18.0.1/",
    "http://168.63.129.16/?comp=versions", // Azure WireServer (GitHub's hosted runners)
    "http://2822734096/", // the same, in decimal
    "http://[::ffff:a83f:8110]/", // and IPv4-mapped
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://user:pass@example.com/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(isPublicHttpUrl(url), false, url);
  }
});

test("ordinary public sites pass, including names that start with digits", () => {
  for (const url of [
    "https://example.com/",
    "http://jane.dev/about",
    "https://10.example.com/",
    "https://100.dev/",
    "https://172-16.vercel.app/",
    "https://localhost-portfolio.vercel.app/",
    "https://8.8.8.8/",
    "https://100.63.0.1/",
    "https://172.32.0.1/",
    "https://[2606:4700::1111]/",
  ]) {
    assert.equal(isPublicHttpUrl(url), true, url);
  }
});
