import { connection } from "next/server";

import { Onboarding } from "@/components/onboarding";
import { loadProfile } from "@/lib/profile/store";

export default async function Home() {
  await connection(); // the profile changes at runtime, so never prerender it
  return <Onboarding initialProfile={await loadProfile()} />;
}
