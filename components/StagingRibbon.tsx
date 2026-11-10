// A corner ribbon on every page of the staging site (lib/site.ts IS_STAGING),
// so nobody mistakes it for the live one. It never takes a click, and sits
// under the Undo toasts (z-[60]).
export function StagingRibbon() {
  return (
    <div
      data-staging-ribbon
      className="pointer-events-none fixed bottom-0 left-0 z-[55] h-28 w-28 overflow-hidden"
    >
      <div className="absolute bottom-[16px] left-[-45px] w-[150px] rotate-45 bg-rose-600 py-1.5 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-white shadow-lg shadow-black/40">
        Staging
      </div>
    </div>
  );
}
