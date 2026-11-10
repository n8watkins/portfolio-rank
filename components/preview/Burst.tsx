/** A short burst of sparks and a ring around its child; nothing under reduced motion. */
export function Burst({ children, on }: { children: React.ReactNode; on: boolean }) {
  return (
    <span className="burst">
      {on && <span className="ring" aria-hidden />}
      {on &&
        Array.from({ length: 8 }, (_, k) => (
          <span key={k} className="spark" style={{ "--a": `${k * 45}deg`, animationDelay: `${(k % 2) * 40}ms` } as React.CSSProperties} aria-hidden />
        ))}
      {children}
    </span>
  );
}
