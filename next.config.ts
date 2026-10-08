import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  experimental: {
    // A navigation or server action made while the connection is down waits and
    // retries when it's back, instead of failing (see components/shell/offline-banner.tsx).
    useOffline: true,
  },
  async headers() {
    return [
      {
        // The service worker is always checked for a new version, and may only do what it says.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

// Compiles "use workflow" / "use step" code (agent runs) and serves the
// workflow runtime's routes under /.well-known/workflow.
export default withWorkflow(nextConfig);
