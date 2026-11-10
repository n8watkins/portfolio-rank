// Badges: one flat list, each a simple rule over counters the app already
// keeps (votes, quizzes, grades, lists, polls, visits). The preview fakes the
// counters per visitor state; the real thing would read them from the
// account (guests keep them in the browser until they sign in).

export type BadgeIcon =
  | "vote"
  | "votes10"
  | "votes100"
  | "votes1000"
  | "quiz"
  | "perfect"
  | "streak7"
  | "grade"
  | "grade10"
  | "list"
  | "list10"
  | "share"
  | "daily3"
  | "crowd10"
  | "early"
  | "poll"
  | "pollstreak"
  | "gem"
  | "owl"
  | "visit50";

export type Badge = {
  id: BadgeIcon;
  name: string;
  how: string;
  /** Hue for the badge art (calm, mid saturation). */
  hue: number;
  /** The counter and the target this badge needs. */
  counter: keyof Counters;
  target: number;
};

export type Counters = {
  votes: number;
  quizzes: number;
  perfectQuizzes: number;
  dayStreak: number;
  grades: number;
  lists: number;
  biggestList: number;
  shares: number;
  dailyStreak: number;
  crowdAgreed: number;
  early: number;
  polls: number;
  pollStreak: number;
  gems: number;
  lateVotes: number;
  visits: number;
};

export const BADGES: Badge[] = [
  { id: "vote", name: "First vote", how: "Vote in a face-off.", hue: 42, counter: "votes", target: 1 },
  { id: "votes10", name: "Warming up", how: "Cast 10 votes.", hue: 32, counter: "votes", target: 10 },
  { id: "votes100", name: "Regular", how: "Cast 100 votes.", hue: 22, counter: "votes", target: 100 },
  { id: "votes1000", name: "Judge", how: "Cast 1,000 votes.", hue: 8, counter: "votes", target: 1000 },
  { id: "quiz", name: "First quiz", how: "Finish a Guess the percentile quiz.", hue: 200, counter: "quizzes", target: 1 },
  { id: "perfect", name: "Sharp eye", how: "Get all 5 within 10 points.", hue: 265, counter: "perfectQuizzes", target: 1 },
  { id: "streak7", name: "Week streak", how: "Play 7 days in a row.", hue: 350, counter: "dayStreak", target: 7 },
  { id: "grade", name: "First grade", how: "Grade a portfolio.", hue: 150, counter: "grades", target: 1 },
  { id: "grade10", name: "Reviewer", how: "Grade 10 portfolios.", hue: 165, counter: "grades", target: 10 },
  { id: "list", name: "Collector", how: "Make your first list.", hue: 185, counter: "lists", target: 1 },
  { id: "list10", name: "Curator", how: "Put 10 sites in one list.", hue: 175, counter: "biggestList", target: 10 },
  { id: "share", name: "Show-off", how: "Share a result or a report.", hue: 300, counter: "shares", target: 1 },
  { id: "daily3", name: "Daily habit", how: "Play the Daily 5 three days running.", hue: 215, counter: "dailyStreak", target: 3 },
  { id: "crowd10", name: "In tune", how: "Agree with the crowd 10 times.", hue: 120, counter: "crowdAgreed", target: 10 },
  { id: "early", name: "Early supporter", how: "Joined during the preview.", hue: 45, counter: "early", target: 1 },
  { id: "poll", name: "Voice", how: "Vote in a poll.", hue: 230, counter: "polls", target: 1 },
  { id: "pollstreak", name: "Pollster", how: "Vote in 4 polls in a row.", hue: 245, counter: "pollStreak", target: 4 },
  { id: "gem", name: "Hidden gem", how: "Save a site that later reaches the top 10%.", hue: 280, counter: "gems", target: 1 },
  { id: "owl", name: "Night owl", how: "Vote after midnight.", hue: 255, counter: "lateVotes", target: 1 },
  { id: "visit50", name: "Explorer", how: "Visit 50 portfolios.", hue: 135, counter: "visits", target: 50 },
];

/** Sample counters per visitor state. */
export function sampleCounters(state: string): Counters {
  const none: Counters = {
    votes: 0, quizzes: 0, perfectQuizzes: 0, dayStreak: 0, grades: 0, lists: 0, biggestList: 0, shares: 0,
    dailyStreak: 0, crowdAgreed: 0, early: 0, polls: 0, pollStreak: 0, gems: 0, lateVotes: 0, visits: 0,
  };
  if (state === "first") return none;
  if (state === "listed")
    return {
      votes: 164, quizzes: 6, perfectQuizzes: 0, dayStreak: 4, grades: 3, lists: 2, biggestList: 7, shares: 1,
      dailyStreak: 3, crowdAgreed: 58, early: 1, polls: 5, pollStreak: 2, gems: 1, lateVotes: 0, visits: 31,
    };
  return { ...none, votes: 12, quizzes: 1, grades: 1, crowdAgreed: 7, early: 1, polls: 1, visits: 9 };
}

export function badgeStatus(c: Counters) {
  return BADGES.map((b) => ({ ...b, have: Math.min(c[b.counter], b.target), earned: c[b.counter] >= b.target }));
}
