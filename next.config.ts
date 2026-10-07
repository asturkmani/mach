import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  /* config options here */
};

// Compiles "use workflow" / "use step" code (agent runs) and serves the
// workflow runtime's routes under /.well-known/workflow.
export default withWorkflow(nextConfig);
