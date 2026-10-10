import { redirect } from "next/navigation";

// @map hidden (an old address that redirects)
// Integrations moved into Settings; old links still work.
export default function IntegrationsPage() {
  redirect("/settings/integrations");
}
