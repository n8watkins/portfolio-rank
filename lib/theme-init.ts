// Shared by the server layout and the client theme hook (lib/theme.ts).

export const THEME_KEY = "pr-theme";

/** Runs before first paint (app/layout.tsx): a saved Light or Dark wins, else the system decides. */
export const THEME_INIT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})()`;
