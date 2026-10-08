import sharp from "sharp";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { useTestDb } from "@/test/db";

// Uploads live in Blob in production; here they're held in memory.
const uploads = new Map<string, Buffer>();
const discarded: string[][] = [];
vi.mock("@/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files")>()),
  readUpload: async (_org: string, pathname: string) => {
    const bytes = uploads.get(pathname);
    if (!bytes) throw new Error("No such upload");
    return bytes;
  },
  discardUploads: async (_org: string, pathnames: string[]) => void discarded.push(pathnames),
}));

const { forModel, restoreOriginals, saveChatAttachments, MAX_CHAT_ATTACHMENTS } = await import("./chat-attachments");
const { listLibrary } = await import("@/lib/files");

const ORG = "org_cedar";
const png = () => sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } }).png().toBuffer();
const user = (id: string, parts: UIMessage["parts"]): UIMessage => ({ id, role: "user", parts });

describe("files attached in the Chief of Staff chat", () => {
  let personId: string;
  beforeEach(async () => {
    await useTestDb();
    uploads.clear();
    discarded.length = 0;
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    personId = (await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" })).id;
  });

  it("saves them to the company's files and links each from the message", async () => {
    uploads.set("uploads/a/photo.png", await png());
    uploads.set("uploads/a/notes.csv", Buffer.from("fund,nav\nA,100\n"));

    const parts = await saveChatAttachments(ORG, personId, [
      { name: "photo.png", blobPathname: "uploads/a/photo.png" },
      { name: "notes.csv", blobPathname: "uploads/a/notes.csv" },
    ]);

    expect(parts).toEqual([
      expect.objectContaining({ type: "file", mediaType: "image/png", filename: "photo.png", url: expect.stringMatching(/^\/files\/[0-9a-f-]{36}\?inline=1$/) }),
      expect.objectContaining({ type: "file", mediaType: "text/csv", filename: "notes.csv" }),
    ]);
    expect((await listLibrary(ORG)).map((f) => f.name).sort()).toEqual(["notes.csv", "photo.png"]);
    expect(discarded).toEqual([["uploads/a/photo.png", "uploads/a/notes.csv"]]);
  });

  it("caps how many can go with one message", async () => {
    const many = Array.from({ length: MAX_CHAT_ATTACHMENTS + 1 }, (_, i) => ({ name: `f${i}.txt`, blobPathname: `uploads/a/f${i}.txt` }));
    await expect(saveChatAttachments(ORG, personId, many)).rejects.toThrow(/at most/);
  });

  it("shows the model the newest message's images and text files, and older ones by name", async () => {
    uploads.set("uploads/a/old.png", await png());
    uploads.set("uploads/a/new.png", await png());
    uploads.set("uploads/a/notes.csv", Buffer.from("fund,nav\nA,100\n"));
    uploads.set("uploads/a/deck.pdf", Buffer.from("%PDF-1.4 not really"));
    const [old] = await saveChatAttachments(ORG, personId, [{ name: "old.png", blobPathname: "uploads/a/old.png" }]);
    const fresh = await saveChatAttachments(ORG, personId, [
      { name: "new.png", blobPathname: "uploads/a/new.png" },
      { name: "notes.csv", blobPathname: "uploads/a/notes.csv" },
      { name: "deck.pdf", blobPathname: "uploads/a/deck.pdf" },
    ]);
    const messages = [
      user("m1", [{ type: "text", text: "Here's the old one" }, old]),
      { id: "m2", role: "assistant" as const, parts: [{ type: "text" as const, text: "Got it." }] },
      user("m3", [{ type: "text", text: "And these" }, ...fresh]),
    ];

    const shown = await forModel(ORG, messages);

    expect(shown[0].parts).toEqual([
      { type: "text", text: "Here's the old one" },
      { type: "text", text: "[Attached earlier, now in the company files: old.png]" },
    ]);
    expect(shown[1]).toBe(messages[1]);
    const newest = shown[2].parts;
    expect(newest[0]).toEqual({ type: "text", text: "And these" });
    expect(newest[1]).toMatchObject({ type: "text", text: expect.stringContaining("new.png (an image, shown below); notes.csv (its text is below); deck.pdf (application/pdf)") });
    expect(newest[2]).toMatchObject({ type: "file", mediaType: "image/jpeg", filename: "new.png", url: expect.stringMatching(/^data:image\/jpeg;base64,/) });
    expect(newest[3]).toEqual({ type: "text", text: '<file name="notes.csv">\nfund,nav\nA,100\n\n</file>' });
    expect(newest).toHaveLength(4);
  });

  it("stores the conversation with its file links, not what the model was shown", () => {
    const original = user("m1", [{ type: "file", mediaType: "image/png", filename: "a.png", url: "/files/x?inline=1" }]);
    const asShown = user("m1", [{ type: "file", mediaType: "image/jpeg", filename: "a.png", url: "data:image/jpeg;base64,AAAA" }]);
    const reply: UIMessage = { id: "m2", role: "assistant", parts: [{ type: "text", text: "Nice." }] };
    expect(restoreOriginals([asShown, reply], [original])).toEqual([original, reply]);
  });
});
