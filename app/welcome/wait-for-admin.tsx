"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Sweep } from "@/components/agent-status";

/** While someone waits to be let in: checks every 15 seconds, so the company opens once an admin says yes. */
export function WaitForAdmin() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <p className="flex items-center gap-2 text-xs text-faint" role="status">
      <Sweep inline /> Waiting for an admin
    </p>
  );
}
