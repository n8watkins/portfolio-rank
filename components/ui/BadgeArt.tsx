import {
  Award,
  ChartColumn,
  ClipboardCheck,
  Compass,
  CalendarCheck,
  Eye,
  Flame,
  Gavel,
  Gem,
  Library,
  ListPlus,
  Lock,
  Medal,
  Megaphone,
  Moon,
  Rocket,
  Share2,
  Sparkles,
  Star,
  Swords,
  Target,
  Trophy,
  Users,
  Vote,
  Zap,
} from "lucide-react";

const ICONS: Record<string, typeof Vote> = {
  vote: Vote,
  votes10: Zap,
  votes100: Swords,
  votes1000: Gavel,
  quiz: Target,
  perfect: Eye,
  streak7: Flame,
  grade: Sparkles,
  grade10: ClipboardCheck,
  list: ListPlus,
  list10: Library,
  share: Share2,
  daily3: CalendarCheck,
  crowd10: Users,
  early: Rocket,
  poll: Megaphone,
  pollstreak: ChartColumn,
  gem: Gem,
  owl: Moon,
  visit50: Compass,
  top25: Award,
  top10: Medal,
  top5: Trophy,
  stier: Star,
};

/**
 * One badge style for all: a rounded hexagon with a soft gradient in the
 * badge's hue, a light rim and a white icon. Locked badges are grey with a
 * small lock.
 */
/** A badge id from lib/games/badges.mjs BADGES. */
export function BadgeArt({ id, hue, locked = false, size = 56 }: { id: string; hue: number; locked?: boolean; size?: number }) {
  const Icon = ICONS[id] ?? Sparkles;
  const gid = `bg-${id}-${locked ? "l" : "e"}`;
  const top = locked ? "hsl(240 4% 62%)" : `hsl(${hue} 70% 62%)`;
  const bottom = locked ? "hsl(240 4% 42%)" : `hsl(${hue} 62% 40%)`;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 64 64" width={size} height={size} className={locked ? "opacity-55" : ""}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={top} />
            <stop offset="1" stopColor={bottom} />
          </linearGradient>
        </defs>
        <path
          d="M32 3.5c1.6 0 3.1.4 4.5 1.2l18 10.4a9 9 0 0 1 4.5 7.8v18.2a9 9 0 0 1-4.5 7.8l-18 10.4a9 9 0 0 1-9 0l-18-10.4A9 9 0 0 1 5 40.9V22.9a9 9 0 0 1 4.5-7.8l18-10.4A9 9 0 0 1 32 3.5Z"
          fill={`url(#${gid})`}
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="1.5"
        />
        <path d="M12 20 32 8.5 52 20" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <Icon className="absolute text-white drop-shadow" style={{ width: size * 0.4, height: size * 0.4 }} strokeWidth={2.2} />
      {locked && (
        <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border border-edge bg-card text-mute">
          <Lock className="h-3 w-3" />
        </span>
      )}
    </span>
  );
}
