import { redirect } from "next/navigation";

// Integrations moved into Settings; old links still work.
export default function IntegrationsPage() {
  redirect("/settings/integrations");
}
