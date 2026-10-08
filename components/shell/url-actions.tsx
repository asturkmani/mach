"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { startCosMessage, useShell } from "./shell";

// What the installed app's icon shortcuts and the phone's share sheet ask for,
// as a link: /?do=new-task, /?do=cos, or something shared to Mach
// (?share_title=…&share_text=…&share_url=…), which becomes a draft to the
// Chief of Staff. Done once, then the link is tidied away.

/** The draft for something shared to Mach: its words, then its link if the words don't already have it. */
export function sharedDraft(params: { title?: string | null; text?: string | null; url?: string | null }): string {
  const text = params.text?.trim() ?? "";
  const url = params.url?.trim() ?? "";
  const title = params.title?.trim() ?? "";
  const parts = [text || title, url && !text.includes(url) ? url : ""].filter(Boolean);
  return parts.length ? `${parts.join("\n")}\n\n` : "";
}

export function UrlActions() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { setCosOpen, openNewTask } = useShell();

  useEffect(() => {
    const action = params.get("do");
    const shared = sharedDraft({ title: params.get("share_title"), text: params.get("share_text"), url: params.get("share_url") });
    if (!action && !shared) return;
    if (shared) startCosMessage(shared, setCosOpen);
    else if (action === "cos") setCosOpen(true);
    else if (action === "new-task") openNewTask();
    const rest = new URLSearchParams(params);
    for (const key of ["do", "share_title", "share_text", "share_url"]) rest.delete(key);
    router.replace(rest.size ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [params, pathname, router, setCosOpen, openNewTask]);

  return null;
}
