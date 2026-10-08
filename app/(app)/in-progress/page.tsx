import { redirect } from "next/navigation";

/** In progress is a section of Home's list view now. */
export default function InProgressPage() {
  redirect("/?view=list");
}
