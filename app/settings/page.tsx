import { AppShell } from "@/components/shell/AppShell";
import { SettingsPanel } from "@/components/preview/SettingsPanel";
import { visitor } from "@/lib/preview/visitor";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const v = await visitor(await searchParams);
  return (
    <AppShell visitor={v} current="other">
      <div className="mx-auto max-w-3xl py-10 sm:py-14">
        <h1 className="rise text-3xl font-bold tracking-tight">Settings</h1>
        <p className="rise mt-1.5 text-sm text-mute">Everything here is saved in this browser.</p>
        <div className="mt-6">
          <SettingsPanel />
        </div>
      </div>
    </AppShell>
  );
}
