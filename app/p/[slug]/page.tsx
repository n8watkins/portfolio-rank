import type { Metadata } from "next";
import { toolsEnabled } from "@/lib/tools/server";
import { LegacyProfile, legacyMetadata } from "./legacy";
import { ProfileV2, profileMetadata } from "./profile-v2";

// A portfolio's profile (/p/<address>). With "Add your portfolio" launched
// (TOOLS_ENABLED) it is the four-part profile with a fix list, for listed and
// added sites alike (./profile-v2.tsx); until then it is the profile as it
// was (./legacy.tsx), so production looks the same while the switch is off.
// Rendered on first visit and then served from the cache, re-rendered at most
// every 5 minutes (ISR); a re-check revalidates it at once. Nothing here
// depends on who is looking: the ♥ state and the owner's tools load in the
// browser.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata(props: Params): Promise<Metadata> {
  return toolsEnabled() ? profileMetadata(props) : legacyMetadata(props);
}

export default async function PortfolioPage(props: Params) {
  return toolsEnabled() ? ProfileV2(props) : LegacyProfile(props);
}
