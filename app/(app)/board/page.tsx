import { redirect } from "next/navigation";

/** The board is a view of Home now. */
export default function BoardPage() {
  redirect("/?view=board");
}
