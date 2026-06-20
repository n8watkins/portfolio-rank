export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="text-5xl font-bold tracking-tight">404</p>
      <p className="mt-3 text-sm text-mute">
        That page isn&apos;t here. It may have been removed from the list.
      </p>
      <a
        href="/"
        className="mt-6 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition hover:opacity-85"
      >
        ← Back to PortfolioRank
      </a>
    </div>
  );
}
