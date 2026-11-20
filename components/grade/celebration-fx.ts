// The grade report's celebration effects, drawn on one canvas over the page.
// Hand-made (no animation library, no downloaded assets) and loaded only
// when a report earns a celebration (components/grade/Celebration.tsx), so
// it costs nothing on any other page. Each level escalates the one before:
//   1 top half   a ring and a burst of sparkles from the tier badge
//   2 top 25%    a confetti pop from the tier badge
//   3 top 10%    two confetti cannons from the bottom corners, and the pop
//   4 top 5%     fireworks over the page, with the cannons
//   5 SSS tier   a gold shower from the top, gold fireworks and the pop
// The canvas ignores the pointer and removes itself when the last particle
// is gone. Callers never start it under prefers-reduced-motion.

type Shape = "rect" | "circle" | "star" | "spark";
type P = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  shape: Shape;
  age: number;
  ttl: number;
  gravity: number;
  drag: number;
  wobble: number;
  delay: number;
  /** A rocket: bursts into its payload when its time is up. */
  burst?: { n: number; colors: string[]; speed: number };
  px?: number;
  py?: number;
};

const CONFETTI = ["#f59e0b", "#fbbf24", "#f43f5e", "#8b5cf6", "#06b6d4", "#22c55e", "#3b82f6"];
const GOLD = ["#fde68a", "#fbbf24", "#f59e0b", "#d97706", "#fff7d6"];
const FIREWORK = [
  ["#fbbf24", "#fde68a", "#fff7d6"],
  ["#f43f5e", "#fb7185", "#fecdd3"],
  ["#8b5cf6", "#a78bfa", "#ddd6fe"],
  ["#06b6d4", "#67e8f9", "#cffafe"],
];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function confetti(x: number, y: number, n: number, { angle = -Math.PI / 2, spread = Math.PI / 2.2, speed = [520, 980] as [number, number], colors = CONFETTI, delay = 0 } = {}): P[] {
  return Array.from({ length: n }, () => {
    const a = angle + rnd(-spread / 2, spread / 2);
    const v = rnd(speed[0], speed[1]);
    return {
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      rot: rnd(0, Math.PI * 2),
      vr: rnd(-12, 12),
      size: rnd(6, 11),
      color: pick(colors),
      shape: Math.random() < 0.7 ? "rect" : "circle",
      age: 0,
      ttl: rnd(2.2, 3.4),
      gravity: 900,
      drag: 1.6,
      wobble: rnd(4, 9),
      delay: delay + rnd(0, 0.08),
    };
  });
}

function sparkles(x: number, y: number, n: number, colors: string[], delay = 0, reach: [number, number] = [160, 320], life: [number, number] = [0.8, 1.2]): P[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + rnd(-0.2, 0.2);
    const v = rnd(reach[0], reach[1]);
    return {
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      rot: rnd(0, Math.PI),
      vr: rnd(-3, 3),
      size: rnd(7, 13),
      color: pick(colors),
      shape: "star",
      age: 0,
      ttl: rnd(life[0], life[1]),
      gravity: 60,
      drag: 3.2,
      wobble: 0,
      delay: delay + rnd(0, 0.06),
    };
  });
}

function rocket(x: number, toY: number, h: number, colors: string[], delay: number, n = 64): P {
  const rise = 0.75;
  return {
    x,
    y: h + 10,
    vx: rnd(-30, 30),
    vy: -(h + 10 - toY) / rise,
    rot: 0,
    vr: 0,
    size: 3,
    color: colors[0],
    shape: "spark",
    age: 0,
    ttl: rise,
    gravity: 0,
    drag: 0,
    wobble: 0,
    delay,
    burst: { n, colors, speed: rnd(260, 360) },
  };
}

function burstOf(p: P): P[] {
  const { n, colors, speed } = p.burst!;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + rnd(-0.05, 0.05);
    const v = speed * rnd(0.55, 1);
    return {
      x: p.x,
      y: p.y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      rot: 0,
      vr: 0,
      size: rnd(2, 3.2),
      color: pick(colors),
      shape: "spark" as Shape,
      age: 0,
      ttl: rnd(1.1, 1.6),
      gravity: 140,
      drag: 1.4,
      wobble: 0,
      delay: 0,
    };
  });
}

function shower(w: number, n: number, colors: string[], over = 2.4): P[] {
  return Array.from({ length: n }, () => ({
    x: rnd(0, w),
    y: rnd(-60, -10),
    vx: rnd(-40, 40),
    vy: rnd(120, 260),
    rot: rnd(0, Math.PI * 2),
    vr: rnd(-8, 8),
    size: rnd(6, 11),
    color: pick(colors),
    shape: Math.random() < 0.25 ? "star" : Math.random() < 0.7 ? "rect" : "circle",
    age: 0,
    ttl: rnd(3.2, 4.4),
    gravity: 180,
    drag: 0.6,
    wobble: rnd(3, 7),
    delay: rnd(0, over),
  }));
}

/** The particles for one level, from `origin` (the tier badge's centre) on a w x h viewport. */
function scene(level: number, origin: { x: number; y: number }, w: number, h: number): P[] {
  const { x, y } = origin;
  const small = w < 640;
  const k = small ? 0.6 : 1;
  const out: P[] = [];
  if (level === 1) {
    const amber = ["#fbbf24", "#f59e0b", "#fde68a"];
    out.push(...sparkles(x, y, 14, amber, 0, [120, 220], [1.2, 1.6]), ...sparkles(x, y, 10, amber, 0.18, [260, 380], [1, 1.4]));
  }
  if (level === 2) {
    out.push(...sparkles(x, y, 10, ["#fbbf24", "#fde68a"]), ...confetti(x, y, Math.round(80 * k), { spread: Math.PI / 1.5, speed: [380, 820] }));
  }
  if (level === 3 || level === 4) {
    const fan = { spread: Math.PI / 5, speed: [900, 1500] as [number, number] };
    out.push(
      ...confetti(-10, h + 10, Math.round(110 * k), { ...fan, angle: -Math.PI / 3 }),
      ...confetti(w + 10, h + 10, Math.round(110 * k), { ...fan, angle: (-2 * Math.PI) / 3 }),
      ...sparkles(x, y, 12, ["#fbbf24", "#fde68a", "#fff7d6"], 0.15)
    );
  }
  if (level === 4) {
    const spots = small ? [0.3, 0.7, 0.5] : [0.2, 0.42, 0.62, 0.82];
    spots.forEach((fx, i) => out.push(rocket(w * fx, h * rnd(0.16, 0.34), h, FIREWORK[i % FIREWORK.length], 0.35 + i * 0.32, small ? 48 : 64)));
  }
  if (level === 5) {
    out.push(
      ...sparkles(x, y, 18, GOLD, 0, [220, 420]),
      ...confetti(x, y, Math.round(60 * k), { spread: Math.PI / 1.4, speed: [420, 900], colors: GOLD }),
      ...shower(w, Math.round(170 * k), GOLD)
    );
    const spots = small ? [0.28, 0.72] : [0.22, 0.5, 0.78];
    spots.forEach((fx, i) => out.push(rocket(w * fx, h * rnd(0.14, 0.3), h, GOLD, 0.5 + i * 0.4, small ? 56 : 72)));
  }
  return out;
}

function star(ctx: CanvasRenderingContext2D, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 === 0 ? r : r * 0.32;
    const a = (i / 8) * Math.PI * 2;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Plays one level's celebration. `origin` is in viewport pixels. Returns a
 * stop function (also called by itself when the scene is over).
 */
export function celebrate(level: number, origin: { x: number; y: number }): () => void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.celebration = String(level);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: `${w}px`, height: `${h}px`, pointerEvents: "none", zIndex: "45" });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return () => {};
  }
  ctx.scale(dpr, dpr);

  let parts = scene(level, origin, w, h);
  let raf = 0;
  let last = performance.now();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    canvas.remove();
  };

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, w, h);
    const born: P[] = [];
    for (const p of parts) {
      if (p.delay > 0) {
        p.delay -= dt;
        continue;
      }
      p.age += dt;
      p.px = p.x;
      p.py = p.y;
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy = p.vy * drag + p.gravity * dt;
      p.x += p.vx * dt + (p.wobble ? Math.sin(p.age * p.wobble) * 0.6 : 0);
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.burst && p.age >= p.ttl) born.push(...burstOf(p));
      if (p.age >= p.ttl) continue;
      const fade = Math.min(1, (p.ttl - p.age) / Math.min(0.6, p.ttl * 0.5));
      ctx.globalAlpha = Math.max(0, fade);
      ctx.fillStyle = p.color;
      ctx.strokeStyle = p.color;
      if (p.shape === "spark") {
        ctx.lineWidth = p.size;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.px - p.vx * 0.03, p.py - p.vy * 0.03);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        continue;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.shape === "rect") {
        // A paper strip turning over: its height follows the spin.
        ctx.fillRect(-p.size / 2, (-p.size / 4) * Math.abs(Math.cos(p.rot * 1.7)), p.size, (p.size / 2) * Math.abs(Math.cos(p.rot * 1.7)) + 0.6);
      } else if (p.shape === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.6, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const grow = Math.min(1, p.age / 0.15);
        star(ctx, (p.size / 2) * grow);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    parts = parts.filter((p) => p.delay > 0 || p.age < p.ttl).concat(born);
    if (!parts.length) return stop();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return stop;
}
