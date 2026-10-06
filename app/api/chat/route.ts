import { createAgentUIStreamResponse } from "ai";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { loadProfile } from "@/lib/profile/store";

export const maxDuration = 120;

export async function POST(request: Request) {
  const { messages } = await request.json();

  let agent;
  try {
    agent = createChiefOfStaff(await loadProfile());
  } catch (error) {
    // Configuration problems (e.g. no model set) are shown to the user as-is.
    return new Response(error instanceof Error ? error.message : "Could not start the Chief of Staff.", {
      status: 500,
    });
  }

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    abortSignal: request.signal,
    // Internal tool for now, so show the real reason (e.g. a missing AI Gateway key).
    onError: (error) => (error instanceof Error ? error.message : "Something went wrong."),
  });
}
