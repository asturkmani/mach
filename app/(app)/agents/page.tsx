import { redirect } from "next/navigation";

// Agents are part of the Team page now; old links (and ?new=1) still work.
export default async function AgentsPage({ searchParams }: PageProps<"/agents">) {
  redirect((await searchParams).new === "1" ? "/team?new=agent" : "/team?show=agents");
}
