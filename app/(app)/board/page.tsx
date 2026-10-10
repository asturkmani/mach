import { redirect } from "next/navigation";

// @map hidden (an old address that redirects)
/** The board is a view of Home now. */
export default function BoardPage() {
  redirect("/?view=board");
}
