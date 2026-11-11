// House style for blog illustrations (the image library and fresh
// illustrations; docs/CONTENT-ENGINE.md, "Images"). One fragment, appended to
// every subject prompt, so the blog reads as one publication. Brand tokens:
// --color-accent #fbbf24 (amber) on the neutral surfaces in app/globals.css.

export const HOUSE_STYLE = [
  "Strictly flat 2D vector illustration for a developer-focused tech publication, simple geometric shapes and UI wireframe elements, solid fills only, no 3D, no isometric or perspective rendering, no gradients, no shadows, no glow, no glossy or realistic textures",
  "neutral palette of warm greys and off-white with a single amber accent (#fbbf24) used sparingly on the focal element",
  "clean composition with generous empty space on one side for a title overlay",
  "wide 16:9 hero crop, calm and confident mood",
  "no letters or numbers anywhere, no text, no words, no code characters, no engraved or printed markings on any object, no logos, no brand marks, no watermarks",
  "no people, no faces, no hands, no recognisable real persons",
].join(". ") + ".";

// Review rule: flux-1-schnell returns a 1024x1024 square, so the engine
// center-crops it to 16:9 (1024x576, pipeline/content/workers-ai.mjs) BEFORE
// the Gemini check, and checks the cropped image. Checking the square made
// the checker fail images for "not 16:9" in the style sample. The crop cuts
// the top and bottom, so subjects keep the focal element near the centre.
export const REVIEW_ON_CROPPED = true;

/** The size every illustration is stored at (16:9). */
export const IMAGE_SIZE = { width: 1024, height: 576 };

/** The full image prompt for a subject. */
export const imagePrompt = (subject) => `${subject}. ${HOUSE_STYLE}`;

/** Every illustration is captioned this way (owner rule). */
export const AI_CAPTION = "AI-generated illustration";

// The library's themes (owner decision 2026-11-10: about 25 themes x 5
// subjects). Tech-first: browser windows, editors, charts and dashboards drawn
// as flat wireframes, never people, so the style rules above are easy to
// keep. `tags` are what the content engine matches an image brief's keywords
// against (lib/content/library.mjs matchLibrary); each subject adds its own.
// Subject 0 of the first 13 themes is the approved round-2 sample.
const t = (id, theme, tags, subjects) => ({ id, theme, tags, subjects: subjects.map(([subject, alt, extra = []]) => ({ subject, alt, tags: extra })) });

export const THEMES = [
  t("design-polish", "Design and visual polish", ["design", "visual", "polish", "layout", "grid", "ui", "spacing", "typography"], [
    ["A flat browser window with a clean UI layout, a faint grid overlay on top, and several rounded components snapping into place along the grid lines, one component highlighted in amber", "Flat browser window with a grid overlay and components snapping into place, one in amber, for design and visual polish", ["components"]],
    ["A flat design canvas with alignment guides crossing over neatly stacked cards, one card in amber exactly on the guide lines", "Design canvas with alignment guides over stacked cards, one amber card aligned, for visual polish", ["alignment"]],
    ["A flat colour palette strip of warm grey swatches beside a browser window that uses them, one amber swatch matching the page's single accent button", "Grey colour swatches beside a page using them, with one amber accent, for colour and design", ["color", "palette"]],
    ["A flat spacing ruler with even gaps between simple layout blocks in a browser window, one gap marker in amber", "Layout blocks with even spacing markers, one amber, for spacing and rhythm", ["whitespace"]],
    ["Two flat browser windows side by side, the left cluttered with overlapping blocks, the right calm and ordered with one amber block", "A cluttered page next to a calm ordered page with one amber block, for design clean-up", ["before", "after", "clean"]],
  ]),
  t("project-storytelling", "Project storytelling", ["projects", "case study", "storytelling", "portfolio", "work", "showcase"], [
    ["A repository card with a branch icon unfolding like a paper fold into a wider case-study page made of image blocks and abstract grey bars, an amber arrow between the card and the page", "Repository card unfolding into a case-study page with an amber arrow, for project storytelling", ["repository"]],
    ["A flat timeline of three project milestones drawn as cards on a line, the last milestone card in amber with a small flag", "Timeline of project milestone cards ending in an amber flag, for project stories", ["timeline", "milestones"]],
    ["A flat project card grid in a browser window, one featured card enlarged and highlighted in amber above the rest", "Project card grid with one featured amber card, for showcasing your best work", ["featured"]],
    ["A flat problem-to-solution diagram: a tangled line on the left becoming a straight amber line on the right through a simple gear shape", "Tangled line turning into a straight amber line through a gear, for problem and solution stories", ["problem", "solution"]],
    ["A flat before-and-after slider over a simple app screen, the after side brighter with one amber element", "Before and after slider over an app screen with an amber element, for showing project impact", ["impact", "results"]],
  ]),
  t("writing-copy", "Writing and copy", ["writing", "copy", "words", "about", "content", "bio"], [
    ["A flat editor window showing tidy paragraph blocks drawn as plain grey bars with no letters, one paragraph block highlighted in amber, a thin cursor line beside it", "Editor window with tidy grey paragraph bars and one amber highlight, for writing and copy", ["editor"]],
    ["A flat page with long grey bars being trimmed by simple scissors into shorter bars, the kept bar in amber", "Scissors trimming long grey bars into short ones, one kept in amber, for tighter copy", ["editing", "concise"]],
    ["A flat speech bubble shape next to a browser hero section, the bubble outlined in amber, all text drawn as plain bars", "Speech bubble beside a hero section, outlined in amber, for voice and tone", ["voice", "tone"]],
    ["A flat notebook with plain bar lines and a pencil shape, one bar underlined in amber", "Notebook with plain lines and a pencil, one line underlined in amber, for drafting copy", ["draft"]],
    ["A flat headline block and subhead block stacked above a small call-to-action button in amber, all text as plain bars", "Headline and subhead blocks above an amber call-to-action, for headline writing", ["headline", "cta"]],
  ]),
  t("first-impressions", "First impressions (the five-second test)", ["first impression", "hero", "five seconds", "landing", "above the fold", "attention"], [
    ["A flat browser tab and window with a stopwatch icon beside it, the hero section of the page lit up in amber while the rest of the page stays grey", "Browser window with a stopwatch and an amber-lit hero section, for first impressions", ["stopwatch"]],
    ["A flat browser window with a fold line across it, the area above the line framed in amber", "Browser window with the area above the fold framed in amber, for above-the-fold content", ["fold"]],
    ["A flat eye-tracking heatmap of soft grey blobs over a simple page layout, the hottest spot on the hero in amber", "Page layout with an eye-tracking heatmap, hottest on the amber hero, for where visitors look", ["heatmap", "scan"]],
    ["A flat hourglass beside a browser window whose hero block is amber and whose lower sections fade to light grey", "Hourglass beside a page with an amber hero block, for the first seconds of a visit", ["time"]],
    ["A flat spotlight cone falling on a single amber hero card inside an otherwise grey browser window", "Spotlight on an amber hero card in a grey page, for making the first view count", ["spotlight", "focus"]],
  ]),
  t("motion-interaction", "Motion and interaction", ["motion", "animation", "interaction", "micro-interactions", "transitions", "hover"], [
    ["Three flat UI cards mid-animation sliding across a browser window, each with fading motion trails behind it, the leading card amber, a cursor arrow nearby", "UI cards mid-animation with motion trails, the leading card amber, for motion and interaction", ["cards"]],
    ["A flat toggle switch and a button shown in three states side by side, the pressed state in amber", "A toggle and a button in three states, the pressed one amber, for interaction states", ["states", "buttons"]],
    ["A flat easing curve drawn as a smooth line on a simple graph grid with a ball moving along it, the ball in amber", "Easing curve with an amber ball moving along it, for animation timing", ["easing", "timing"]],
    ["A flat cursor arrow hovering over a card that lifts slightly with an amber outline", "Cursor hovering over a card that lifts with an amber outline, for hover effects", ["cursor"]],
    ["A flat loading skeleton of grey blocks turning into a finished card from left to right, the finished part in amber", "Loading skeleton turning into a finished amber card, for loading states", ["loading", "skeleton"]],
  ]),
  t("dark-mode-theming", "Dark mode and theming", ["dark mode", "theme", "theming", "light mode", "colors", "contrast"], [
    ["One flat interface window split down the middle into a light half and a dark half, with the same layout blocks on both sides, a small amber toggle switch at the seam", "One interface split into light and dark halves with an amber toggle, for dark mode and theming", ["toggle"]],
    ["A flat crescent moon and a sun shape on either side of a small amber switch above a simple page outline", "Moon and sun on either side of an amber switch, for light and dark themes", ["moon", "sun"]],
    ["A flat stack of three theme cards in light grey, mid grey and charcoal, the same small amber accent on each", "Three theme cards from light to dark with the same amber accent, for consistent theming", ["tokens"]],
    ["A flat contrast checker: two overlapping squares, light and dark, with a small amber check badge between them", "Two overlapping light and dark squares with an amber check badge, for contrast in themes", ["accessibility"]],
    ["A flat dark browser window with soft charcoal panels and one amber accent element, calm and readable", "Dark browser window with charcoal panels and one amber accent, for dark interfaces", ["dark"]],
  ]),
  t("performance-page-weight", "Performance and page weight", ["performance", "speed", "page weight", "lighthouse", "load time", "core web vitals", "bundle"], [
    ["A flat page-load waterfall chart of horizontal bars in staggered rows, one short amber bar, beside a small light bundle box with a feather-light feel, no numbers or labels", "Page-load waterfall chart beside a small light bundle box with an amber bar, for performance and page weight", ["waterfall"]],
    ["A flat speedometer gauge with the needle in the fast zone, the needle in amber, beside a simple browser window", "Speedometer with an amber needle in the fast zone, for page speed", ["speedometer", "fast"]],
    ["A flat balance scale with a heavy grey image block on one side and a light amber block on the other", "Balance scale weighing a heavy grey block against a light amber one, for page weight", ["images", "weight"]],
    ["A flat stack of boxes being compressed by a simple press into one small amber box", "Boxes compressed into one small amber box, for smaller bundles", ["compression", "minify"]],
    ["A flat progress bar filling quickly across a browser window, the filled part amber, with simple speed lines behind it", "Progress bar filling quickly in amber with speed lines, for fast loading", ["progress"]],
  ]),
  t("careers-hiring", "Careers and hiring", ["careers", "hiring", "recruiters", "jobs", "resume", "candidates"], [
    ["A flat recruiter's screen showing a row of portfolio browser tabs and a grid of candidate cards, one candidate card highlighted in amber with a checkmark shape, no faces", "Recruiter screen with portfolio tabs and one amber highlighted candidate card, for careers and hiring", ["recruiter"]],
    ["A flat resume page drawn as plain bars beside a portfolio browser window, a link line connecting them in amber", "Resume page linked to a portfolio window by an amber line, for resumes and portfolios", ["resume", "cv"]],
    ["A flat inbox list of message bars with one amber envelope shape at the top", "Inbox with one amber envelope at the top, for hearing back from employers", ["inbox", "offer"]],
    ["A flat career ladder of simple steps rising to the right, the top step in amber", "Simple steps rising to an amber top step, for career growth", ["career", "growth"]],
    ["A flat briefcase shape beside a browser window with one amber bookmark ribbon", "Briefcase beside a browser window with an amber bookmark, for job hunting", ["job hunt"]],
  ]),
  t("data-rankings", "Data and rankings", ["data", "rankings", "leaderboard", "stats", "charts", "elo", "scores"], [
    ["A flat leaderboard dashboard window with a ranked list of rows on one side and a bar chart on the other, the tallest bar and the top row in amber, no numbers or labels", "Leaderboard dashboard with bar charts and an amber top rank, for data and rankings", ["dashboard"]],
    ["A flat scatter plot of grey dots with one cluster circled in amber, no numbers or labels", "Scatter plot of grey dots with one amber-circled cluster, for patterns in the data", ["scatter", "patterns"]],
    ["A flat line chart rising in steps across a simple grid, the last segment in amber, no numbers or labels", "Line chart rising in steps with an amber last segment, for trends", ["trend", "line chart"]],
    ["Two flat cards facing each other with a small versus divider between them, one card glowing amber as the winner", "Two cards facing off with the winning card in amber, for head-to-head comparisons", ["comparison", "versus", "vote"]],
    ["A flat donut chart of grey segments with one amber segment pulled slightly out, no numbers or labels", "Donut chart with one amber segment pulled out, for shares and percentages", ["donut", "percent"]],
  ]),
  t("tools-stacks", "Tools and stacks", ["tools", "stack", "tech stack", "editor", "terminal", "workflow"], [
    ["A flat code editor window and a terminal window side by side, with abstract layered stack shapes of simple geometric tiles floating between them, one tile amber, no logos and no code characters", "Code editor and terminal windows with abstract stack shapes and one amber tile, for tools and stacks", ["layers"]],
    ["A flat toolbox open with simple tool shapes inside, one wrench shape in amber, no markings", "Open toolbox with one amber wrench, for developer tools", ["toolbox"]],
    ["A flat stack of four rounded layers like a layered cake, the middle layer in amber", "Four stacked layers with the middle one amber, for choosing a stack", ["architecture"]],
    ["A flat terminal window with plain grey prompt bars and one amber cursor block", "Terminal window with grey bars and an amber cursor block, for command-line work", ["terminal", "cli"]],
    ["A flat set of puzzle pieces fitting together, one piece in amber clicking into place", "Puzzle pieces fitting together with one amber piece, for tools that fit together", ["integration"]],
  ]),
  t("ai-agents", "AI and agents", ["ai", "agents", "llm", "automation", "copilot", "machine learning"], [
    ["A flat browser window of a page layout with an AI assistant reviewing the code, drawn as a network of connected nodes and lines over the window, one central node in amber", "AI assistant drawn as a node network over a browser window, one amber node, for AI and developer tooling", ["assistant"]],
    ["A flat flowchart of rounded steps passing a small token between them, one step box in amber, no labels", "Flowchart of steps with an amber step, for agent workflows", ["workflow", "pipeline"]],
    ["A flat chat panel of plain grey message bubbles beside an editor window, the newest bubble outlined in amber", "Chat panel beside an editor with an amber-outlined bubble, for coding with AI", ["chat"]],
    ["A flat robot arm shape placing a card into a browser window layout, the card in amber, no faces", "Robot arm placing an amber card into a page layout, for automation", ["robot"]],
    ["A flat neural network of three columns of circles joined by lines, one path of lines in amber", "Neural network diagram with one amber path, for how models work", ["neural network"]],
  ]),
  t("community-feedback", "Community and feedback", ["community", "feedback", "reviews", "comments", "code review", "open discussion"], [
    ["Flat comment threads with nested reply bars and a pull-request review panel with a diff made of grey lines and an amber approve checkmark badge, no text", "Comment threads and a pull-request review with an amber approval badge, for community and feedback", ["pull request"]],
    ["A flat ring of small speech bubbles around a central browser window, one bubble in amber", "Speech bubbles around a browser window, one amber, for getting feedback", ["bubbles"]],
    ["A flat row of five star shapes with four filled in grey and one in amber, beside a simple card", "Star rating with one amber star beside a card, for ratings and reviews", ["rating", "stars"]],
    ["A flat sticky-note board with grey notes and one amber note pinned in the centre", "Board of grey sticky notes with an amber one in the centre, for collecting feedback", ["notes"]],
    ["A flat megaphone shape beside a simple post card with a small amber heart badge", "Megaphone beside a post card with an amber heart, for sharing your work", ["share", "social"]],
  ]),
  t("standing-out", "Standing out", ["standing out", "unique", "personal brand", "differentiation", "memorable"], [
    ["A tidy row of identical flat browser-window thumbnails with exactly one amber window lifted slightly above the row", "Row of grey browser thumbnails with one amber window raised above, for standing out", ["thumbnails"]],
    ["A flat grid of grey circles with one amber square among them", "Grid of grey circles with one amber square, for being different", ["different"]],
    ["A flat stack of identical grey cards with one amber card pulled out and turned to face forward", "Stack of grey cards with one amber card pulled out, for being memorable", ["memorable"]],
    ["A flat paper plane in amber flying above a row of grey paper planes", "Amber paper plane flying above grey ones, for rising above the crowd", ["rise"]],
    ["A flat signpost with one amber arrow pointing a different way from the grey arrows", "Signpost with one amber arrow pointing a different way, for your own direction", ["direction"]],
  ]),
  t("open-source", "Open source", ["open source", "github", "contributions", "repositories", "maintainers", "pull request"], [
    ["A flat contribution graph of small grey squares in rows with a few squares in amber, no numbers or labels", "Contribution graph of grey squares with a few amber ones, for open source activity", ["contribution graph"]],
    ["A flat branching git graph of lines and dots merging back into a main line, the merge dot in amber", "Git branch graph merging back with an amber merge dot, for contributing", ["git", "branch", "merge"]],
    ["A flat repository card with a star shape and a fork shape, the star in amber, no text", "Repository card with an amber star and a fork shape, for open source projects", ["star", "fork"]],
    ["Several small flat cranes stacking building blocks into one structure, the top block amber", "Small cranes stacking blocks into one structure with an amber top block, for building together", ["collaboration"]],
    ["A flat open padlock beside a code window, the padlock shackle in amber", "Open padlock beside a code window with an amber shackle, for open code", ["license"]],
  ]),
  t("remote-work", "Remote work", ["remote work", "remote", "async", "distributed", "home office", "time zones"], [
    ["A flat desk setup with a laptop and a monitor showing simple layout blocks, a plant shape and an amber lamp, no people", "Desk with a laptop, monitor, plant and amber lamp, for remote work", ["desk", "home office"]],
    ["A flat world map of simple grey shapes with three connected dots across time zones, one dot in amber", "World map with connected dots across time zones, one amber, for distributed teams", ["time zones", "global"]],
    ["A flat video-call window grid of empty grey tiles with one tile outlined in amber, no faces", "Video-call grid of empty tiles with one amber tile, for remote meetings", ["video call", "meetings"]],
    ["A flat clock and a calendar beside a message thread of grey bars, one message marked in amber", "Clock and calendar beside a thread with one amber message, for async work", ["async"]],
    ["A flat house outline containing a small browser window with an amber cursor", "House outline containing a browser window with an amber cursor, for working from home", ["home"]],
  ]),
  t("interviews", "Interviews", ["interviews", "technical interview", "whiteboard", "questions", "preparation", "hiring process"], [
    ["A flat whiteboard with simple box-and-arrow diagram shapes, one box in amber, no letters", "Whiteboard with a box-and-arrow diagram and one amber box, for technical interviews", ["whiteboard", "system design"]],
    ["A flat checklist card with three ticked grey boxes and one amber tick, all text drawn as plain bars", "Checklist with ticked boxes and one amber tick, for interview preparation", ["checklist", "prep"]],
    ["Two flat chairs facing a small table with a laptop on it, the laptop screen amber, no people", "Two empty chairs and a table with an amber laptop screen, for interview day", ["meeting"]],
    ["A flat question-mark shape made of simple blocks beside a lightbulb in amber", "Question mark beside an amber lightbulb, for answering interview questions", ["questions", "answers"]],
    ["A flat code editor split into a problem panel and a solution panel, a single amber check badge between them, no code characters", "Editor with problem and solution panels and an amber check, for coding interviews", ["coding challenge"]],
  ]),
  t("side-projects", "Side projects", ["side projects", "hobby", "weekend", "build", "indie", "prototype"], [
    ["A flat small rocket shape lifting off from a laptop screen, the rocket in amber", "Amber rocket lifting off from a laptop screen, for launching side projects", ["launch", "rocket"]],
    ["A flat workbench with small UI component blocks being assembled, one block in amber, no hands", "Workbench assembling UI blocks with one amber block, for building something small", ["workbench", "prototype"]],
    ["A flat calendar with weekend squares highlighted in amber beside a small code window", "Calendar with amber weekends beside a code window, for weekend projects", ["weekend"]],
    ["A flat seedling growing from a code window into a small tree with one amber leaf", "Seedling growing from a code window into a tree with an amber leaf, for growing a project", ["grow"]],
    ["A flat sketchbook with a wireframe drawing and an amber pencil line turning into a real browser window", "Sketchbook wireframe turning into a browser window along an amber line, for idea to prototype", ["idea", "sketch"]],
  ]),
  t("accessibility", "Accessibility", ["accessibility", "a11y", "inclusive", "contrast", "keyboard", "screen reader"], [
    ["A flat browser window with a clear focus ring drawn around one button in amber, the rest of the page calm and grey", "Browser window with an amber focus ring around one button, for keyboard accessibility", ["focus", "keyboard"]],
    ["A flat keyboard shape with the tab key highlighted in amber, no letters on the keys", "Keyboard with one amber key, for keyboard navigation", ["tab"]],
    ["A flat contrast scale of squares from light to dark with a checkmark on one amber-bordered pair", "Contrast scale with one amber-bordered pair checked, for readable contrast", ["contrast", "colour"]],
    ["A flat page layout with simple landmark brackets around header, main and footer blocks, the main bracket in amber", "Page layout with landmark brackets, main in amber, for semantic structure", ["semantic html", "landmarks"]],
    ["A flat sound wave shape coming from a small speaker beside a browser window, the wave in amber", "Amber sound wave from a speaker beside a browser window, for screen readers", ["screen reader", "audio"]],
  ]),
  t("mobile", "Mobile", ["mobile", "responsive", "phone", "touch", "small screens", "breakpoints"], [
    ["A flat phone outline, tablet outline and laptop outline in a row showing the same layout adapting, the phone layout's key block in amber", "Phone, tablet and laptop showing one adapting layout, amber on the phone, for responsive design", ["responsive", "devices"]],
    ["A flat phone outline with a thumb-reach zone drawn as a soft arc, the main button inside it in amber, no hands", "Phone with a thumb-reach arc and an amber button inside it, for touch-friendly design", ["thumb", "touch"]],
    ["A flat phone with a stacked single-column layout of cards, one card in amber", "Phone with a single-column card layout and one amber card, for mobile layouts", ["layout"]],
    ["A flat ruler sliding along the width of a browser window with breakpoint markers, one marker in amber", "Ruler with breakpoint markers along a browser window, one amber, for breakpoints", ["breakpoints"]],
    ["A flat phone with a simple bottom navigation bar of icon shapes, the active icon in amber", "Phone with a bottom navigation bar and an amber active icon, for mobile navigation", ["navigation"]],
  ]),
  t("security", "Security", ["security", "privacy", "https", "passwords", "safety", "secrets"], [
    ["A flat shield shape in front of a browser window, the shield's centre in amber", "Shield with an amber centre in front of a browser window, for web security", ["shield"]],
    ["A flat closed padlock on a browser address bar drawn as a plain bar, the padlock in amber", "Address bar with an amber padlock, for HTTPS", ["https", "padlock"]],
    ["A flat key shape beside a vault door outline, the key in amber", "Amber key beside a vault door, for keeping secrets safe", ["keys", "vault"]],
    ["A flat form with a password field of dots and a strength meter bar, the meter filled in amber", "Password field with a strength meter filled in amber, for strong passwords", ["password"]],
    ["A flat firewall of simple brick blocks between two browser windows, one brick in amber", "Brick firewall between two windows with one amber brick, for protecting a site", ["firewall"]],
  ]),
  t("deployment-cloud", "Deployment and cloud", ["deployment", "cloud", "hosting", "ci/cd", "servers", "domains"], [
    ["A flat cloud shape above a row of server rack blocks connected by thin lines, one connection line in amber", "Cloud above server racks with one amber connection, for cloud hosting", ["servers", "hosting"]],
    ["A flat pipeline of three connected boxes ending in a globe shape, the last arrow in amber", "Pipeline of boxes ending in a globe with an amber arrow, for deploying a site", ["pipeline", "ci/cd"]],
    ["A flat globe made of simple lines with small edge nodes around it, one node in amber", "Line globe with edge nodes, one amber, for a fast global site", ["edge", "cdn"]],
    ["A flat rocket on a launch pad beside a browser window with an amber go light", "Rocket on a launch pad beside a browser window with an amber go light, for shipping to production", ["ship", "release"]],
    ["A flat domain address bar drawn as a plain bar connected to a small server block, the connector in amber", "Address bar connected to a server by an amber line, for custom domains", ["domain", "dns"]],
  ]),
  t("learning-growth", "Learning and growth", ["learning", "growth", "skills", "courses", "practice", "self-taught"], [
    ["A flat stack of book shapes with a small browser window on top, the top book in amber, no titles", "Stack of books with a browser window on top, the top book amber, for learning to code", ["books"]],
    ["A flat staircase of code-window blocks rising upward, the top block in amber", "Staircase of code-window blocks rising to an amber top, for levelling up", ["level up", "progress"]],
    ["A flat lightbulb whose filament is drawn as simple circuit lines, the bulb glass in amber", "Lightbulb with circuit-line filament in amber, for new ideas and understanding", ["ideas"]],
    ["A flat mountain path with small flag markers, the summit flag in amber", "Mountain path with flags and an amber summit flag, for long-term goals", ["goals"]],
    ["A flat graduation cap shape resting on a laptop, the tassel in amber", "Graduation cap on a laptop with an amber tassel, for courses and bootcamps", ["bootcamp", "courses"]],
  ]),
  t("job-market", "The job market", ["job market", "hiring trends", "layoffs", "salaries", "openings", "market"], [
    ["A flat job board window of listing cards in rows, one listing card highlighted in amber, all text as plain bars", "Job board of listing cards with one amber listing, for job openings", ["job board", "openings"]],
    ["A flat bar chart of hiring by quarter with one rising amber bar, no numbers or labels", "Bar chart with one rising amber bar, for hiring trends", ["trends", "chart"]],
    ["A flat magnifying glass over a grid of small company building shapes, one building in amber", "Magnifying glass over company buildings, one amber, for researching employers", ["companies", "search"]],
    ["A flat weather vane on a rooftop pointing toward an amber arrow, beside simple chart lines", "Weather vane pointing to an amber arrow beside chart lines, for where the market is heading", ["outlook"]],
    ["A flat funnel shape with many grey dots entering and one amber dot leaving at the bottom", "Funnel with many grey dots in and one amber dot out, for competitive hiring", ["funnel", "applications"]],
  ]),
  t("frontend-frameworks", "Frontend frameworks", ["frontend", "frameworks", "react", "components", "javascript", "css"], [
    ["A flat component tree of nested rounded boxes connected by lines, one leaf box in amber, no labels", "Component tree of nested boxes with one amber leaf, for frontend frameworks", ["component tree"]],
    ["A flat set of three interchangeable framework blocks of different simple shapes plugging into one browser window, one block in amber, no logos", "Three framework blocks plugging into a browser window, one amber, for choosing a framework", ["choice"]],
    ["A flat browser window built from stacked reusable component cards, one repeated card in amber", "Page built from reusable component cards, one amber, for component design", ["reusable"]],
    ["A flat state diagram of three circles with arrows between them, the active circle in amber", "State diagram of three circles with an amber active state, for state management", ["state"]],
    ["A flat CSS box model drawn as nested rectangles for margin, border and padding, the content box in amber, no labels", "Nested box-model rectangles with an amber content box, for CSS layout", ["css", "box model"]],
  ]),
  t("backend-data", "Backend and data", ["backend", "databases", "apis", "data", "servers", "sql"], [
    ["A flat database cylinder connected to an API plug shape and a browser window, the plug in amber", "Database connected to an amber API plug and a browser window, for backend and APIs", ["api", "database"]],
    ["A flat table grid of plain rows and columns with one row highlighted in amber, no text", "Table grid with one amber row, for databases and queries", ["table", "sql"]],
    ["A flat request and response diagram: two arrows between a client window and a server block, the response arrow in amber", "Request and response arrows between a window and a server, the response amber, for how APIs work", ["requests", "http"]],
    ["A flat queue of small boxes moving along a conveyor into a server block, one box in amber", "Conveyor of boxes moving into a server, one amber, for queues and background jobs", ["queue", "jobs"]],
    ["A flat stack of three database cylinders with a sync arrow loop around them, the arrow in amber", "Three database cylinders with an amber sync loop, for replication and backups", ["backup", "sync"]],
  ]),
  t("freelancing", "Freelancing", ["freelancing", "clients", "contracting", "invoices", "independent", "consulting"], [
    ["A flat proposal document drawn as plain bars with a signature line in amber, beside a small browser window", "Proposal with an amber signature line beside a browser window, for winning clients", ["proposal", "contract"]],
    ["A flat calendar and a clock with project blocks scheduled across the week, one block in amber", "Calendar and clock with scheduled blocks, one amber, for managing freelance time", ["schedule", "time"]],
    ["A flat invoice card with plain bars and an amber paid stamp shape, no letters or numbers", "Invoice card with an amber paid stamp, for getting paid as a freelancer", ["invoice", "paid"]],
    ["A flat handshake-free deal icon: two puzzle pieces joining with an amber seam", "Two puzzle pieces joining at an amber seam, for client partnerships", ["partnership"]],
    ["A flat portfolio browser window with a pricing card row, the middle card raised in amber, all text as plain bars", "Portfolio with a row of pricing cards, the middle one amber, for freelance services", ["pricing", "services"]],
  ]),
];

/**
 * Every library subject, in queue order: the first subject of every theme,
 * then the second of every theme, and so on, so each night's batch spreads
 * over all the themes.
 */
export const LIBRARY_SUBJECTS = THEMES.flatMap((th) =>
  th.subjects.map((s, index) => ({ theme: th.id, themeLabel: th.theme, index, subject: s.subject, alt: s.alt, tags: [...th.tags, ...s.tags], prompt: imagePrompt(s.subject) }))
).sort((a, b) => a.index - b.index || THEMES.findIndex((x) => x.id === a.theme) - THEMES.findIndex((x) => x.id === b.theme));
