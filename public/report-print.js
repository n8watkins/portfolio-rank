// The printable report's "Save as PDF" button (lib/grader/report.mjs). A file
// of its own, not an onclick attribute: the CSP allows no inline event
// handlers (script-src-attr 'none', next.config.ts).
document.querySelector("button.print")?.addEventListener("click", () => window.print());
