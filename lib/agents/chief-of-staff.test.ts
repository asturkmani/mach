import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";

import { createChiefOfStaff } from "./chief-of-staff";
import { emptyProfile, getCompanyName, getSection, parsePeople } from "@/lib/profile/markdown";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function toolCall(id: string, toolName: string, input: object) {
  return { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) };
}

// First model call: record the organisation via tools. Second: reply in text.
function scriptedModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            toolCall("1", "set_company_name", { name: "Greenfield Supplies" }),
            toolCall("2", "upsert_person", { name: "Aisha Khan", role: "Founder & CEO", reportsTo: "" }),
            toolCall("3", "upsert_person", { name: "Sam Lee", role: "Head of Sales", reportsTo: "Aisha Khan" }),
            toolCall("4", "update_section", { section: "Overview", content: "Refurbished farm equipment, UK-wide." }),
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "Got it. Who else is on the team?" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

describe("Chief of Staff", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mach-"));
    process.env.MACH_DATA_DIR = dataDir;
  });

  it("writes the organisation into the profile markdown file", async () => {
    const agent = createChiefOfStaff(emptyProfile(), scriptedModel());
    const result = await agent.generate({ prompt: "We're Greenfield Supplies. I'm Aisha, the CEO; Sam runs sales." });

    expect(result.text).toBe("Got it. Who else is on the team?");

    const saved = await readFile(path.join(dataDir, "company-profile.md"), "utf8");
    expect(getCompanyName(saved)).toBe("Greenfield Supplies");
    expect(getSection(saved, "Overview")).toBe("Refurbished farm equipment, UK-wide.");
    expect(parsePeople(saved).map((p) => [p.name, p.reportsTo])).toEqual([
      ["Aisha Khan", ""],
      ["Sam Lee", "Aisha Khan"],
    ]);
  });

  it("refuses to start without a model", () => {
    delete process.env.CHIEF_OF_STAFF_MODEL;
    expect(() => createChiefOfStaff(emptyProfile())).toThrow(/CHIEF_OF_STAFF_MODEL/);
  });
});
