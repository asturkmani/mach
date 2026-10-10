import { describe, expect, it } from "vitest";

import { trimToolResults } from "./trim";

const big = (n: number) => "x".repeat(n);
const call = (i: number, size: number) => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "fetch_page", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "fetch_page", output: { type: "text", value: big(size) } }] },
];

describe("trimming old tool results", () => {
  it("leaves a run alone until it gets large", () => {
    const messages = [{ role: "user", content: "go" }, ...call(1, 50_000), ...call(2, 50_000)];
    expect(trimToolResults(messages)).toBe(messages);
  });

  it("cuts old large results to a note, keeps the newest whole, and keeps tool calls paired", () => {
    const messages = [{ role: "user", content: "go" }, ...Array.from({ length: 20 }, (_, i) => call(i, 20_000)).flat()];
    const trimmed = trimToolResults(messages);
    const outputs = trimmed.filter((m) => m.role === "tool").map((m) => (m.content as { output: { value: string } }[])[0].output.value);
    expect(outputs.slice(0, 8).every((v) => v.startsWith("[Trimmed"))).toBe(true);
    expect(outputs.slice(-6).every((v) => v.length === 20_000)).toBe(true);
    expect(trimmed).toHaveLength(messages.length);
    expect(trimmed.filter((m) => m.role === "assistant")).toEqual(messages.filter((m) => m.role === "assistant"));
  });

  it("moves in blocks, so the prompt's start stays the same between steps", () => {
    const run = (n: number) => [{ role: "user", content: "go" }, ...Array.from({ length: n }, (_, i) => call(i, 20_000)).flat()];
    const before = trimToolResults(run(19));
    const after = trimToolResults(run(20));
    expect(JSON.stringify(after.slice(0, before.length - 2))).toBe(JSON.stringify(before.slice(0, before.length - 2)));
  });
});
