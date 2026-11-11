// House style for blog illustrations (the image library and fresh
// illustrations). One fragment, appended to every subject prompt, so the blog
// reads as one publication. Brand tokens: --color-accent #fbbf24 (amber) on
// the neutral surfaces in app/globals.css.

export const HOUSE_STYLE = [
  "Strictly flat 2D vector editorial illustration, simple geometric shapes, solid fills, no 3D, no perspective rendering, no shading gradients, no glossy or realistic textures",
  "neutral palette of warm greys and off-white with a single amber accent (#fbbf24) used sparingly on the focal element",
  "clean composition with generous empty space on one side for a title overlay",
  "wide 16:9 hero crop, calm and confident mood",
  "no letters or numbers anywhere, no text, no words, no engraved or printed markings on any object, no logos, no brand marks, no watermarks",
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

// One subject prompt per theme. Subjects are objects and abstract scenes,
// never people, so the style rules above are easy to keep.
export const THEMES = [
  {
    id: "design-polish",
    theme: "Design and visual polish",
    subject: "A tidy arrangement of overlapping rounded rectangles and a ruler-straight alignment grid, one card slightly highlighted in amber, suggesting careful spacing and refinement",
    alt: "Abstract illustration of aligned cards on a grid, one highlighted in amber, for design and visual polish",
  },
  {
    id: "project-storytelling",
    theme: "Project storytelling",
    subject: "A winding path of stepping stones across a neutral landscape leading to a glowing amber flag on a small hill, each stone a different simple shape, a journey told in stages",
    alt: "Illustration of a path of stepping stones leading to an amber flag, for project storytelling",
  },
  {
    id: "writing-copy",
    theme: "Writing and copy",
    subject: "A large pencil resting across a blank sheet of paper with a few abstract grey lines and one amber underline, a fountain pen nib beside it, the page otherwise empty",
    alt: "Illustration of a pencil and a sheet with grey lines and an amber underline, for writing and copy",
  },
  {
    id: "first-impressions",
    theme: "First impressions (the five-second test)",
    subject: "A large stopwatch dial frozen at a few seconds beside a simple browser window shape, with a single amber spotlight beam falling on the window's main block",
    alt: "Illustration of a stopwatch beside a browser window lit by an amber spotlight, for first impressions",
  },
  {
    id: "motion-interaction",
    theme: "Motion and interaction",
    subject: "A circle moving along a curved dotted trajectory with faded ghost copies trailing behind it, the leading circle amber, and a simple cursor arrow near a button shape",
    alt: "Illustration of an amber circle with a motion trail and a cursor arrow, for motion and interaction",
  },
  {
    id: "dark-mode-theming",
    theme: "Dark mode and theming",
    subject: "A circle split diagonally into a light half and a dark half, with a small amber crescent moon and sun symbol at the seam, two plain interface cards below in matching light and dark",
    alt: "Illustration of a circle split into light and dark halves with an amber accent, for dark mode and theming",
  },
  {
    id: "performance-page-weight",
    theme: "Performance and page weight",
    subject: "A balance scale weighing a heavy stack of grey boxes against one small amber feather-light block, the scale tipping gently, suggesting a lightweight page",
    alt: "Illustration of a balance scale with grey boxes and a light amber block, for performance and page weight",
  },
  {
    id: "careers-hiring",
    theme: "Careers and hiring",
    subject: "An open door with warm amber light spilling out onto a grey floor, a simple staircase of three steps leading up to it, a briefcase silhouette resting on the bottom step",
    alt: "Illustration of an open door with amber light and a short staircase, for careers and hiring",
  },
  {
    id: "standing-out",
    theme: "Standing out",
    subject: "A tidy row of identical grey rounded squares with exactly one amber square lifted slightly above the row and casting a soft shadow",
    alt: "Illustration of a row of grey squares with one amber square raised above, for standing out",
  },
  {
    id: "data-rankings",
    theme: "Data and rankings",
    subject: "A podium of three stepped blocks of different heights in greys, the tallest in amber, with a simple bar chart silhouette behind it and no numbers or labels",
    alt: "Illustration of a three-step podium with the top block in amber and a bar chart behind, for data and rankings",
  },
  {
    id: "tools-stacks",
    theme: "Tools and stacks",
    subject: "A neat vertical stack of layered slabs like a technology stack, each a different simple geometric tile in grey, with a small amber gear at the top layer and a wrench leaning on the side",
    alt: "Illustration of stacked layered slabs with an amber gear on top, for tools and stacks",
  },
  {
    id: "community-feedback",
    theme: "Community and feedback",
    subject: "Several overlapping rounded speech bubbles of different sizes in greys, one amber bubble in the middle containing a simple checkmark shape, no text inside any bubble",
    alt: "Illustration of overlapping speech bubbles with one amber bubble holding a checkmark, for community and feedback",
  },
];
