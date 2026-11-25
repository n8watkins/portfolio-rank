"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Expand, Flag, Minus, Monitor, Pause, Play, Plus, RotateCcw, Smartphone, X } from "lucide-react";
import { ReportProblem } from "@/components/profile/ReportProblem";
import type { ShotView } from "@/lib/profile-next/load";
import s from "./profile-next.module.css";

// The screenshots on the redesigned profile (the owner's round 7 notes): the
// laptop and the phone side by side on one baseline, the phone over the
// laptop's right edge, the progress line under them, then Expand and Play on
// the left and "Report a problem" in the corner.
//
// With the full-page captures (lib/shots.ts fullPagePreview) both pictures
// play by themselves, slowly and together: 0.6 s at the top, down at about
// one screen every seven seconds, 1 s at the bottom, back up three times as
// fast, then they stop at the top. They start once the pictures are in view,
// hold while a mouse is over them, the tab is hidden or the viewer is open,
// and stop for good when a hand scrolls them (until Play). With reduced
// motion they never start by themselves. With a mouse over either picture
// the wheel scrolls both, at about a third of normal speed, and hands back to
// the page at either end; on a touch screen a swipe scrolls the page. A click
// or tap on either opens the large viewer on that device. Without full-page
// captures the pictures are the top screenful, still, with no Play.

const WAIT_TOP = 600;
const WAIT_BOTTOM = 1000;
const DOWN_MIN = 6000;
const DOWN_MAX = 45000;
/** Window heights a second on the way down: 0.14 is one screen about every 7 s. */
const PACE = 0.14;
const BACK = 3;
const WHEEL = 0.3;
const ZMIN = 1;
const ZMAX = 4;

type Kind = "desk" | "mob";
type Phase = "idle" | "run" | "paused" | "done";
type Step = { wait?: number; from?: number; to?: number; T: number; t: number };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reduceMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Shots({ desktop, phone, domain, url }: { desktop: ShotView; phone: ShotView | null; domain: string; url: string }) {
  const tall = desktop.tall || Boolean(phone?.tall);
  const deskRef = useRef<HTMLDivElement>(null);
  const mobRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const figRef = useRef<HTMLElement>(null);
  const progRef = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [viewer, setViewer] = useState<Kind | null>(null);
  const run = useRef({ phase: "idle" as Phase, steps: [] as Step[], last: 0, explicit: false, f: 0, raf: 0, hover: false, visible: false, held: false });

  /** The windows that pan; the lead sets the pace (the desktop page when it is tall). */
  const wins = useCallback(() => [deskRef.current, mobRef.current].filter((w): w is HTMLDivElement => Boolean(w)), []);
  const lead = useCallback(() => (desktop.tall ? deskRef.current : mobRef.current) ?? deskRef.current, [desktop.tall]);
  const maxY = (w: HTMLElement | null) => (w ? Math.max(0, w.scrollHeight - w.clientHeight) : 0);

  /** Both windows to the same point of their pages (0 top, 1 bottom), and the progress line. */
  const apply = useCallback(
    (f: number) => {
      run.current.f = f;
      for (const w of wins()) w.scrollTop = Math.round(f * maxY(w));
      if (progRef.current) progRef.current.style.width = `${f * 100}%`;
    },
    [wins],
  );

  const setRunPhase = useCallback((p: Phase) => {
    run.current.phase = p;
    setPhase(p);
  }, []);

  // The frame loop calls itself through a stable function, so it is always the newest one.
  const loopRef = useRef<(t: number) => void>(() => {});
  const tick = useCallback((t: number) => loopRef.current(t), []);
  const loop = useCallback(
    (t: number) => {
      const r = run.current;
      r.raf = 0;
      if (r.phase !== "run") return;
      const holding = document.hidden || (r.hover && !r.explicit) || r.held || !r.visible;
      if (holding || !r.last) {
        r.last = t;
      } else {
        let dt = Math.min(64, t - r.last);
        r.last = t;
        while (dt > 0 && r.steps.length) {
          const st = r.steps[0];
          const total = st.wait ?? st.T;
          const use = Math.min(dt, total - st.t);
          st.t += use;
          dt -= use;
          if (st.wait == null) apply(st.from! + (st.to! - st.from!) * ease(Math.min(1, st.t / st.T)));
          if (st.t >= total - 0.01) r.steps.shift();
        }
        if (!r.steps.length) {
          apply(0);
          setRunPhase("done");
          return;
        }
      }
      r.raf = requestAnimationFrame(tick);
    },
    [apply, setRunPhase, tick],
  );
  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  /** The plan from where the pictures are now: down (unless at the bottom), a pause, back up. */
  const start = useCallback(
    (fromTop: boolean, explicit: boolean) => {
      const r = run.current;
      const w = lead();
      const m = maxY(w);
      if (!w || !m) return;
      const T = Math.min(DOWN_MAX, Math.max(DOWN_MIN, (m / (w.clientHeight * PACE)) * 1000));
      const f = fromTop ? 0 : r.f;
      if (fromTop) apply(0);
      const steps: Step[] = [];
      if (fromTop) steps.push({ wait: WAIT_TOP, T: WAIT_TOP, t: 0 });
      if (f < 0.999) steps.push({ from: f, to: 1, T: Math.max(400, T * (1 - f)), t: 0 }, { wait: WAIT_BOTTOM, T: WAIT_BOTTOM, t: 0 });
      steps.push({ from: 1, to: 0, T: Math.max(400, T / BACK), t: 0 });
      r.steps = steps;
      r.last = 0;
      r.explicit = explicit;
      setRunPhase("run");
      if (!r.raf) r.raf = requestAnimationFrame(tick);
    },
    [apply, lead, tick, setRunPhase],
  );

  /** Start by itself when it may: in view, both pictures loaded, not held, motion allowed, never started. */
  const kick = useCallback(() => {
    const r = run.current;
    // Both pictures sized (an image from the cache may be complete before this ran, so ask the images).
    const loaded = wins().every((w) => {
      const img = w.querySelector("img");
      return !img || (img.complete && img.naturalHeight > 0);
    });
    if (r.phase === "idle" && tall && loaded && r.visible && !r.held && !reduceMotion()) start(true, false);
    else if (r.phase === "run" && !r.raf) r.raf = requestAnimationFrame(tick);
  }, [wins, tall, start, tick]);

  // In view: at least 60% of the pictures, or half the screen's height of them.
  useEffect(() => {
    const fig = figRef.current;
    if (!fig || !tall) return;
    const io = new IntersectionObserver(
      ([en]) => {
        run.current.visible = en.intersectionRatio >= 0.6 || (!!en.rootBounds && en.intersectionRect.height >= en.rootBounds.height * 0.5);
        kick();
      },
      { rootMargin: "-64px 0px 0px 0px", threshold: [0, 0.3, 0.5, 0.6, 0.8, 1] },
    );
    io.observe(fig);
    const onVis = () => {
      if (!document.hidden) kick();
    };
    document.addEventListener("visibilitychange", onVis);
    const r = run.current;
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(r.raf);
      r.raf = 0;
    };
  }, [tall, kick]);

  // The wheel over either picture scrolls both, a third as fast, and hands back to the page at either end.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !tall) return;
    const onWheel = (ev: WheelEvent) => {
      if (ev.ctrlKey || ev.metaKey || !ev.deltaY) return;
      const over = (ev.target as Element | null)?.closest?.("[data-win]") as HTMLDivElement | null;
      const w = over && maxY(over) ? over : lead();
      const m = maxY(w);
      if (!w || !m) return;
      const y = run.current.f * m;
      const dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? w.clientHeight : 1) * WHEEL;
      if ((dy < 0 && y <= 0) || (dy > 0 && y >= m - 1)) return;
      ev.preventDefault();
      if (run.current.phase === "run") setRunPhase("paused");
      apply(Math.min(1, Math.max(0, (y + dy) / m)));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [tall, apply, lead, setRunPhase]);

  // The viewer holds the pictures while it is open.
  useEffect(() => {
    run.current.held = viewer != null;
    if (viewer == null) kick();
  }, [viewer, kick]);

  const onLoad = () => {
    // Keep the pictures where they were once a tall image sizes itself.
    apply(run.current.f);
    kick();
  };

  const press = () => {
    const r = run.current;
    if (r.phase === "run") {
      setRunPhase("paused");
      return;
    }
    start(r.phase !== "paused", true);
  };

  const playLabel = phase === "run" ? "Pause the screenshots" : phase === "done" ? "Play the screenshots again" : "Play the screenshots";
  const PlayIcon = phase === "run" ? Pause : phase === "done" ? RotateCcw : Play;

  return (
    <figure
      ref={figRef}
      className={s.comp}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") run.current.hover = true;
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") {
          run.current.hover = false;
          kick();
        }
      }}
    >
      <div ref={stageRef} className={s.compStage} title={tall ? "Scroll here to look through the page" : undefined}>
        <div className={`${s.compDesk} ${phone ? "" : s.solo}`}>
          <div className={s.devBar} aria-hidden>
            <i />
            <i />
            <i />
            <span>{domain}</span>
          </div>
          <div ref={deskRef} className={s.win} data-win="desk" aria-hidden onClick={() => setViewer("desk")}>
            {/* eslint-disable-next-line @next/next/no-img-element -- our own capture, sized by the window */}
            <img src={desktop.src} width={desktop.width} height={desktop.height} alt="" className={desktop.tall ? undefined : s.still} fetchPriority="high" draggable={false} onLoad={desktop.tall ? onLoad : undefined} />
          </div>
        </div>
        {phone && (
          <div className={s.compMob}>
            <div ref={mobRef} className={s.win} data-win="mob" aria-hidden onClick={() => setViewer("mob")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- our own capture, sized by the window */}
              <img src={phone.src} width={phone.width} height={phone.height} alt="" className={phone.tall ? undefined : s.still} draggable={false} onLoad={phone.tall ? onLoad : undefined} />
            </div>
          </div>
        )}
      </div>
      {tall && (
        <div className={s.winProg} aria-hidden>
          <i ref={progRef} />
        </div>
      )}
      <div className={s.compCtl}>
        <button type="button" className={s.compOpen} onClick={() => setViewer(window.innerWidth < 640 && phone ? "mob" : "desk")} aria-label={phone ? "Open the screenshots large, to switch between Mobile and Desktop and zoom" : "Open the screenshot large, to zoom"}>
          <Expand className={s.icS} aria-hidden />
          <span>Expand</span>
        </button>
        {tall && (
          <button type="button" className={s.compPlay} onClick={press} aria-label={playLabel} title={playLabel}>
            <PlayIcon aria-hidden fill={PlayIcon === Play ? "currentColor" : "none"} />
          </button>
        )}
        <ReportProblem url={url} domain={domain} className={s.reportWrap} buttonClassName={s.report}>
          <Flag className={s.icS} aria-hidden />
          <span>
            Report<span className={s.rpMore}> a problem</span>
          </span>
        </ReportProblem>
      </div>
      <figcaption className={s.vh}>
        {domain} on {phone ? "Desktop and on Mobile, side by side" : "Desktop"}
        {tall ? ", scrolling slowly through the whole page." : ", the top of the page."}
      </figcaption>
      {viewer && <Viewer kind={viewer} setKind={setViewer} desktop={desktop} phone={phone} domain={domain} onClose={() => setViewer(null)} />}
    </figure>
  );
}

/**
 * The whole page, large and centred: Mobile or Desktop, zoom with the buttons,
 * a double click or Ctrl (Cmd) and the wheel on a computer, a pinch or a
 * double tap on touch. It never scrolls by itself.
 */
function Viewer({ kind, setKind, desktop, phone, domain, onClose }: { kind: Kind; setKind: (k: Kind) => void; desktop: ShotView; phone: ShotView | null; domain: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [z, setZ] = useState(1);
  const zRef = useRef(1);
  const view = kind === "mob" && phone ? phone : desktop;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = before;
    };
  }, []);

  const base = useCallback(() => {
    const w = stageRef.current?.clientWidth ?? 0;
    return kind === "mob" ? Math.min(w - 2, 390) : w - 2;
  }, [kind]);

  const size = useCallback(() => {
    if (pageRef.current) pageRef.current.style.width = `${Math.round(base() * zRef.current)}px`;
  }, [base]);

  /** Zoom keeping the point under (cx, cy) of the stage where it is. */
  const zoom = useCallback(
    (to: number, cx?: number, cy?: number) => {
      const st = stageRef.current;
      const pg = pageRef.current;
      if (!st || !pg) return;
      const next = Math.min(ZMAX, Math.max(ZMIN, to));
      const cur = zRef.current;
      if (Math.abs(next - cur) < 0.001) return;
      const x = cx ?? st.clientWidth / 2;
      const y = cy ?? st.clientHeight / 2;
      const ox = (st.scrollLeft + x - pg.offsetLeft) / cur;
      const oy = (st.scrollTop + y - pg.offsetTop) / cur;
      zRef.current = next;
      setZ(next);
      size();
      st.scrollLeft = ox * next + pg.offsetLeft - x;
      st.scrollTop = oy * next + pg.offsetTop - y;
    },
    [size],
  );

  /** Another device starts fitted (and at the top, below). */
  const show = (k: Kind) => {
    if (k === kind) return;
    zRef.current = 1;
    setZ(1);
    setKind(k);
  };
  useEffect(() => {
    size();
    if (stageRef.current) {
      stageRef.current.scrollTop = 0;
      stageRef.current.scrollLeft = 0;
    }
  }, [kind, size]);

  useEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    const onResize = () => size();
    const onWheel = (ev: WheelEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const r = st.getBoundingClientRect();
      zoom(zRef.current * Math.exp(-ev.deltaY * 0.0025), ev.clientX - r.left, ev.clientY - r.top);
    };
    let pinch: { d: number; z: number; cx: number; cy: number } | null = null;
    let lastTap = 0;
    const onTouchStart = (ev: TouchEvent) => {
      const r = st.getBoundingClientRect();
      if (ev.touches.length === 2) {
        const [a, b] = [ev.touches[0], ev.touches[1]];
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zRef.current, cx: (a.clientX + b.clientX) / 2 - r.left, cy: (a.clientY + b.clientY) / 2 - r.top };
      } else if (ev.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300) {
          ev.preventDefault();
          zoom(zRef.current > 1.2 ? 1 : 2.5, ev.touches[0].clientX - r.left, ev.touches[0].clientY - r.top);
          lastTap = 0;
        } else lastTap = now;
      }
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (!pinch || ev.touches.length !== 2) return;
      ev.preventDefault();
      const [a, b] = [ev.touches[0], ev.touches[1]];
      zoom(pinch.z * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d), pinch.cx, pinch.cy);
    };
    const onTouchEnd = (ev: TouchEvent) => {
      if (ev.touches.length < 2) pinch = null;
    };
    window.addEventListener("resize", onResize);
    st.addEventListener("wheel", onWheel, { passive: false });
    st.addEventListener("touchstart", onTouchStart, { passive: false });
    st.addEventListener("touchmove", onTouchMove, { passive: false });
    st.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("resize", onResize);
      st.removeEventListener("wheel", onWheel);
      st.removeEventListener("touchstart", onTouchStart);
      st.removeEventListener("touchmove", onTouchMove);
      st.removeEventListener("touchend", onTouchEnd);
    };
  }, [size, zoom]);

  const label = kind === "mob" && phone ? "Mobile" : "Desktop";
  return (
    <dialog
      ref={ref}
      className={s.vw}
      aria-labelledby="pn-vw-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close();
      }}
      onKeyDown={(e) => {
        if (e.key === "+" || e.key === "=") zoom(zRef.current * 1.5);
        else if (e.key === "-") zoom(zRef.current / 1.5);
      }}
    >
      <div className={s.vwBar}>
        {phone && (
          <div className={s.vwTabs} role="group" aria-label="View">
            <button type="button" aria-pressed={kind === "mob"} onClick={() => show("mob")}>
              <Smartphone className={s.icS} aria-hidden />
              Mobile
            </button>
            <button type="button" aria-pressed={kind === "desk"} onClick={() => show("desk")}>
              <Monitor className={s.icS} aria-hidden />
              Desktop
            </button>
          </div>
        )}
        <div className={s.vwZoom}>
          <button type="button" className={s.vwBtn} aria-label="Zoom out" disabled={z <= ZMIN + 0.001} onClick={() => zoom(zRef.current / 1.5)}>
            <Minus aria-hidden />
          </button>
          <span className={s.vwPct} aria-live="polite">
            {Math.round(z * 100)}%
          </span>
          <button type="button" className={s.vwBtn} aria-label="Zoom in" disabled={z >= ZMAX - 0.001} onClick={() => zoom(zRef.current * 1.5)}>
            <Plus aria-hidden />
          </button>
          <button type="button" className={`${s.vwBtn} ${s.vwFit}`} onClick={() => zoom(1)}>
            Fit
          </button>
        </div>
        <button type="button" className={s.vwBtn} aria-label="Close" onClick={() => ref.current?.close()}>
          <X aria-hidden />
        </button>
        <p className={s.vwTitle} id="pn-vw-title">
          {domain}, {label}, {view.tall ? "whole page" : "top of the page"}
        </p>
      </div>
      <div
        ref={stageRef}
        className={s.vwStage}
        tabIndex={0}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          zoom(zRef.current > 1.2 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
        }}
      >
        <div ref={pageRef} className={s.vwPage}>
          {/* eslint-disable-next-line @next/next/no-img-element -- our own capture, zoomed by its box */}
          <img key={view.src} src={view.src} width={view.width} height={view.height} alt={`The ${label.toLowerCase()} page of ${domain}${view.tall ? ", top to bottom" : ""}`} draggable={false} />
        </div>
      </div>
      <div className={s.vwFoot}>Pinch or double-tap to zoom. On a computer: the buttons, double-click, or Ctrl and scroll.</div>
    </dialog>
  );
}
