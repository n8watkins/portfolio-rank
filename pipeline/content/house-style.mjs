// House style for blog illustrations (the image library and fresh
// illustrations). One fragment, appended to every subject prompt, so the blog
// reads as one publication. Brand tokens: --color-accent #fbbf24 (amber) on
// the neutral surfaces in app/globals.css.

export const HOUSE_STYLE = [
  "Strictly flat 2D vector illustration for a developer-focused tech publication, simple geometric shapes and UI wireframe elements, solid fills only, no 3D, no isometric or perspective rendering, no gradients, no shadows, no glow, no glossy or realistic textures",
  "neutral palette of warm greys and off-white with a single amber accent (#fbbf24) used sparingly on the focal element",
  "clean composition with generous empty space on one side for a title overlay",
  "wide 16:9 hero crop, calm and confident mood",
  "no letters or numbers anywhere, no text, no words, no code characters, no engraved or printed markings on any object, no logos, no brand marks, no watermarks",
  "no people, no faces, no hands, no recognisable real persons",
].join(". ") + ".";

// Review rule: flux-1-schnell returns a 1024x1024 square, so the engine
// center-crops it to 16:9 (1024x576, then scales to 1280x720) BEFORE the
// Gemini review, and reviews the cropped image. Reviewing the square made the
// checker fail images for "not 16:9" in the style sample. The review prompt
// must also say the subject is judged inside the 16:9 frame, and that the
// crop may cut the top and bottom, so keep the focal element near the centre.
export const REVIEW_ON_CROPPED = true;

export const HERO_SIZE = { width: 1280, height: 720 };

/** The full image prompt for a subject. */
export const imagePrompt = (subject) => `${subject}. ${HOUSE_STYLE}`;

// One subject prompt per theme. Tech-first: browser windows, editors, charts
// and dashboards drawn as flat wireframes, never people, so the style rules
// above are easy to keep. Design is one theme among twelve.
export const THEMES = [
  {
    id: "design-polish",
    theme: "Design and visual polish",
    subject: "A flat browser window with a clean UI layout, a faint grid overlay on top, and several rounded components snapping into place along the grid lines, one component highlighted in amber",
    alt: "Flat browser window with a grid overlay and components snapping into place, one in amber, for design and visual polish",
  },
  {
    id: "project-storytelling",
    theme: "Project storytelling",
    subject: "A repository card with a branch icon unfolding like a paper fold into a wider case-study page made of image blocks and abstract grey bars, an amber arrow between the card and the page",
    alt: "Repository card unfolding into a case-study page with an amber arrow, for project storytelling",
  },
  {
    id: "writing-copy",
    theme: "Writing and copy",
    subject: "A flat editor window showing tidy paragraph blocks drawn as plain grey bars with no letters, one paragraph block highlighted in amber, a thin cursor line beside it",
    alt: "Editor window with tidy grey paragraph bars and one amber highlight, for writing and copy",
  },
  {
    id: "first-impressions",
    theme: "First impressions (the five-second test)",
    subject: "A flat browser tab and window with a stopwatch icon beside it, the hero section of the page lit up in amber while the rest of the page stays grey",
    alt: "Browser window with a stopwatch and an amber-lit hero section, for first impressions",
  },
  {
    id: "motion-interaction",
    theme: "Motion and interaction",
    subject: "Three flat UI cards mid-animation sliding across a browser window, each with fading motion trails behind it, the leading card amber, a cursor arrow nearby",
    alt: "UI cards mid-animation with motion trails, the leading card amber, for motion and interaction",
  },
  {
    id: "dark-mode-theming",
    theme: "Dark mode and theming",
    subject: "One flat interface window split down the middle into a light half and a dark half, with the same layout blocks on both sides, a small amber toggle switch at the seam",
    alt: "One interface split into light and dark halves with an amber toggle, for dark mode and theming",
  },
  {
    id: "performance-page-weight",
    theme: "Performance and page weight",
    subject: "A flat page-load waterfall chart of horizontal bars in staggered rows, one short amber bar, beside a small light bundle box with a feather-light feel, no numbers or labels",
    alt: "Page-load waterfall chart beside a small light bundle box with an amber bar, for performance and page weight",
  },
  {
    id: "careers-hiring",
    theme: "Careers and hiring",
    subject: "A flat recruiter's screen showing a row of portfolio browser tabs and a grid of candidate cards, one candidate card highlighted in amber with a checkmark shape, no faces",
    alt: "Recruiter screen with portfolio tabs and one amber highlighted candidate card, for careers and hiring",
  },
  {
    id: "data-rankings",
    theme: "Data and rankings",
    subject: "A flat leaderboard dashboard window with a ranked list of rows on one side and a bar chart on the other, the tallest bar and the top row in amber, no numbers or labels",
    alt: "Leaderboard dashboard with bar charts and an amber top rank, for data and rankings",
  },
  {
    id: "tools-stacks",
    theme: "Tools and stacks",
    subject: "A flat code editor window and a terminal window side by side, with abstract layered stack shapes of simple geometric tiles floating between them, one tile amber, no logos and no code characters",
    alt: "Code editor and terminal windows with abstract stack shapes and one amber tile, for tools and stacks",
  },
  {
    id: "ai-assistance",
    theme: "AI and developer tooling",
    subject: "A flat browser window of a page layout with an AI assistant reviewing the code, drawn as a network of connected nodes and lines over the window, one central node in amber",
    alt: "AI assistant drawn as a node network over a browser window, one amber node, for AI and developer tooling",
  },
  {
    id: "community-feedback",
    theme: "Community and feedback",
    subject: "Flat comment threads with nested reply bars and a pull-request review panel with a diff made of grey lines and an amber approve checkmark badge, no text",
    alt: "Comment threads and a pull-request review with an amber approval badge, for community and feedback",
  },
  {
    id: "standing-out",
    theme: "Standing out",
    subject: "A tidy row of identical flat browser-window thumbnails with exactly one amber window lifted slightly above the row",
    alt: "Row of grey browser thumbnails with one amber window raised above, for standing out",
  },
];
