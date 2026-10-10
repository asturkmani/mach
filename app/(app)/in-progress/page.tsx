import { redirect } from "next/navigation";

// @map hidden (an old address that redirects)
/** In progress is a section of Home's list view now. */
export default function InProgressPage() {
  redirect("/?view=list");
}
