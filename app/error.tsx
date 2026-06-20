"use client";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="text-2xl font-bold tracking-tight">Something broke.</p>
      <p className="mt-3 text-sm text-mute">
        That&apos;s on us, not you. Try again in a moment.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={reset}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition hover:opacity-85"
        >
          Try again
        </button>
        <a
          href="/"
          className="rounded-lg border border-edge px-5 py-2.5 text-sm font-semibold transition hover:border-mute"
        >
          Home
        </a>
      </div>
    </div>
  );
}
