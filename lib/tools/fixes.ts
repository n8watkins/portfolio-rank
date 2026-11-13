// Plain-words fixes for the Lighthouse audits a portfolio most often fails,
// keyed by audit id (Lighthouse 13, which PageSpeed runs today). An audit
// with no entry here is not shown: a list of jargon nobody can act on is
// worse than a short list of things a person can fix this afternoon.

type Fix = { title?: string; tip: string };

const FIXES: Record<string, Fix> = {
  // Speed (Lighthouse "insights" and diagnostics)
  "render-blocking-insight": {
    title: "Stylesheets and scripts hold up the first paint",
    tip: "Load scripts with defer or async, and inline the few CSS rules the top of the page needs. Frameworks like Next.js and Astro do this for you.",
  },
  "image-delivery-insight": {
    title: "Images are bigger than they need to be",
    tip: "Export images at the size they are shown, in WebP or AVIF. A 4000 px photo in a 400 px card is the most common reason a portfolio is slow.",
  },
  "cache-insight": {
    title: "Files aren't cached between visits",
    tip: "Give images, fonts and built JS and CSS a long Cache-Control (a year, with hashed file names). Vercel, Netlify and Cloudflare Pages do this for built files by default.",
  },
  "legacy-javascript-insight": {
    title: "Old-browser JavaScript is shipped to everyone",
    tip: "Raise your build target (browserslist or tsconfig target) to modern browsers, so polyfills for old ones are left out.",
  },
  "document-latency-insight": {
    title: "The server is slow to send the page",
    tip: "Serve the page as static HTML from a CDN instead of rendering it on every visit, and avoid redirect chains to your main address.",
  },
  "font-display-insight": {
    title: "Text waits for web fonts",
    tip: "Add font-display: swap to your @font-face rules (or display=swap on Google Fonts links) so text shows at once.",
  },
  "lcp-discovery-insight": {
    title: "The main image is found late",
    tip: "Don't lazy-load the hero image. Give it fetchpriority=\"high\", or preload it, so the browser starts on it first.",
  },
  "lcp-breakdown-insight": {
    title: "The largest element shows up late",
    tip: "Make the hero text or image part of the first HTML, not something JavaScript renders after loading.",
  },
  "cls-culprits-insight": {
    title: "The layout jumps while loading",
    tip: "Give images and embeds a width and height (or aspect-ratio), and reserve space for anything that loads in later.",
  },
  "network-dependency-tree-insight": {
    title: "Files load one after another",
    tip: "Cut chains where one file asks for the next: preconnect to font and image hosts, and bundle small scripts together.",
  },
  "forced-reflow-insight": {
    title: "Scripts force extra layout work",
    tip: "Avoid reading sizes (offsetHeight, getBoundingClientRect) right after changing styles in the same frame, often in scroll or animation code.",
  },
  "dom-size-insight": {
    title: "The page has a very large number of elements",
    tip: "Trim wrapper divs and render long lists or galleries in pages, so the browser has less to lay out.",
  },
  "third-parties-insight": {
    title: "Third-party scripts slow the page",
    tip: "Drop widgets you don't need (chat bubbles, several analytics tools) and load the rest after the page is up.",
  },
  "duplicated-javascript-insight": {
    title: "The same library is shipped twice",
    tip: "Check your bundle for duplicate packages (npm dedupe, or one version of a library across the app).",
  },
  "modern-http-insight": {
    title: "Files aren't served over HTTP/2 or HTTP/3",
    tip: "Host on a CDN (Cloudflare, Vercel, Netlify), which serves every file over a modern protocol.",
  },
  "unused-javascript": {
    title: "Unused JavaScript is downloaded",
    tip: "Split code per page and remove heavy libraries you barely use (a whole animation or icon library for one effect).",
  },
  "unused-css-rules": {
    title: "Unused CSS is downloaded",
    tip: "Remove CSS frameworks or themes you don't use, or let Tailwind or your bundler strip unused rules.",
  },
  "bootup-time": {
    title: "JavaScript takes long to run",
    tip: "Ship less JavaScript: a portfolio is mostly text and images, so static HTML with small islands of script is fastest.",
  },
  "mainthread-work-breakdown": {
    title: "The browser is busy for seconds",
    tip: "Heavy animations, 3D scenes and big frameworks keep the phone busy. Load them after the page is usable, or only on desktop.",
  },
  "total-byte-weight": {
    title: "The page is heavy to download",
    tip: "Compress images and video, and don't autoplay large background videos on phones.",
  },
  "viewport-insight": {
    title: "The page isn't set up for phones",
    tip: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to the head.",
  },
  // Accessibility
  "color-contrast": {
    title: "Some text is hard to read",
    tip: "Raise the contrast of light-gray or colored text against its background to at least 4.5:1 (WebAIM's contrast checker helps).",
  },
  "image-alt": { title: "Images have no alt text", tip: "Describe each meaningful image in its alt attribute; use alt=\"\" for decoration." },
  "link-name": { title: "Some links have no text", tip: "Icon-only links (GitHub, LinkedIn) need an aria-label, like aria-label=\"GitHub\"." },
  "button-name": { title: "Some buttons have no name", tip: "Give icon buttons (menu, theme toggle) an aria-label that says what they do." },
  label: { title: "Form fields have no labels", tip: "Give every input in your contact form a <label>, not only a placeholder." },
  "html-has-lang": { title: "The page doesn't say its language", tip: "Add lang=\"en\" (or your language) to the <html> tag." },
  "heading-order": { title: "Headings skip levels", tip: "Go h1, then h2, then h3, without jumping from h1 to h4 for looks; style them with CSS instead." },
  "target-size": { title: "Tap targets are too small", tip: "Make links and buttons at least 24 by 24 px, with space between them, so they're easy to tap on a phone." },
  "aria-allowed-attr": { tip: "Remove ARIA attributes that don't belong on the element they're on." },
  "aria-hidden-focus": { title: "Hidden elements can still be focused", tip: "Elements inside aria-hidden=\"true\" must not be focusable: add tabindex=\"-1\" or remove aria-hidden." },
  list: { title: "Lists are built wrong", tip: "Put only <li> elements directly inside <ul> and <ol>." },
  "landmark-one-main": { title: "No main landmark", tip: "Wrap the page's main content in a <main> element." },
  // Search and sharing
  "meta-description": { title: "No meta description", tip: "Add a one-sentence <meta name=\"description\">: your name, what you do and what you're looking for." },
  "document-title": { title: "No page title", tip: "Give the page a <title> like \"Jane Doe - Frontend Developer\"." },
  "link-text": { title: "Links say \"click here\"", tip: "Make link text say where it goes (\"Read the case study\", not \"here\")." },
  "is-crawlable": { title: "Search engines are told to skip this page", tip: "Remove the noindex robots tag or header, unless you want to stay out of search results." },
  "crawlable-anchors": { title: "Some links can't be followed", tip: "Use real <a href> links for navigation, not click handlers on divs." },
  "robots-txt": { title: "robots.txt has errors", tip: "Fix or remove robots.txt; a broken one can hide your site from search." },
  canonical: { title: "The canonical link is wrong", tip: "Point <link rel=\"canonical\"> at this page's own public address." },
  // Best practices
  "errors-in-console": { title: "The page logs errors", tip: "Open the browser console on your site and fix the errors: they often mean a broken feature or a missing file." },
  "is-on-https": { title: "Not everything loads over HTTPS", tip: "Serve the site and every image and script over https://." },
  "image-aspect-ratio": { title: "Images are stretched", tip: "Show images at their own aspect ratio, or crop them with object-fit: cover." },
  "image-size-responsive": { title: "Images look blurry on sharp screens", tip: "Serve images at twice their shown size (srcset) for high-density screens." },
  deprecations: { title: "The page uses deprecated browser features", tip: "Update old libraries; the warnings in the console name what to replace." },
  "inspector-issues": { title: "The browser reports problems", tip: "Open DevTools, Issues tab, on your site and fix what it lists (often cookies or mixed content)." },
};

/** The plain-words fix for an audit, or null when it isn't one worth showing. */
export function fixFor(auditId: string): Fix | null {
  return FIXES[auditId] ?? null;
}
