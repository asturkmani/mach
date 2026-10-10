import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as fileByLink } from "@/app/api/files/[token]/route";
import { appTools } from "@/lib/agents/app-tools";
import { handleEmail, handleWhatsApp } from "@/lib/channels/inbound";
import { getDb } from "@/lib/db";
import { fileLinkToken, readFileLinkToken } from "@/lib/file-links";
import { listLibrary, saveVersion } from "@/lib/files";
import type { Actor } from "@/lib/operations";
import { createOrganization, setEmailInbox } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { createTask, listMessages } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { scriptedModel } from "@/test/scripted-model";

const ORG = "org_cedar";
const MEDIA = "https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages/MM1/Media/ME1";
const CSV = "fund,nav\nA,100\nB,250\n";

/** Twilio, AgentMail and their downloads, faked: records what was posted, serves the files. */
function stubProviders() {
  const posted: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === MEDIA || url === "https://cdn.agentmail.example/positions.csv") {
        return new Response(CSV, { headers: { "Content-Type": "text/csv" } });
      }
      if (url.includes("/attachments/att_1")) {
        return Response.json({ attachment_id: "att_1", size: CSV.length, filename: "positions.csv", content_type: "text/csv", download_url: "https://cdn.agentmail.example/positions.csv" });
      }
      posted.push({ url, body: String(init?.body ?? "") });
      return Response.json({ sid: "SM_out", message_id: "m_out" });
    }),
  );
  return posted;
}

describe("files by WhatsApp and email", () => {
  let actor: Actor;

  beforeEach(async () => {
    await useTestDb();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-token");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
    vi.stubEnv("AGENTMAIL_API_KEY", "am_test");
    vi.stubEnv("APP_URL", "https://mach.example");
    vi.stubEnv("MACH_SECRETS_KEY", randomBytes(32).toString("base64"));
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    await getDb().query("update people set whatsapp = '447700900123' where id = $1", [ahmed.id]);
    actor = { organizationId: ORG, personId: ahmed.id, name: "Ahmed", userId: "user_ahmed", isAdmin: true };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps a file sent on WhatsApp in their files, private, and reads it with the message", async () => {
    stubProviders();
    const model = scriptedModel(["B is the bigger one."]);
    await handleWhatsApp(
      { from: "+447700900123", body: "Which fund is bigger?", media: 1, attachments: [{ url: MEDIA, type: "text/csv" }] },
      { model, research: false },
    );
    const [file] = await listLibrary(ORG, { viewer: actor.personId });
    expect(file).toMatchObject({ name: expect.stringMatching(/^WhatsApp .* 1\.csv$/), visibility: "private", ownerPersonId: actor.personId });
    expect(await listLibrary(ORG, { viewer: "00000000-0000-0000-0000-000000000000" })).toHaveLength(0);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("Which fund is bigger?");
    expect(prompt).toContain("B,250");
  });

  it("keeps an email's attachments too", async () => {
    stubProviders();
    await setEmailInbox(ORG, "cedar-legacy@agentmail.to");
    const model = scriptedModel(["Got it."]);
    await handleEmail(
      { inbox_id: "cedar-legacy@agentmail.to", message_id: "<m1@cedar.example>", from: "ahmed@cedar.example", subject: "Positions", text: "", attachments: [{ attachment_id: "att_1", filename: "positions.csv" }] },
      { model, research: false },
    );
    expect((await listLibrary(ORG, { viewer: actor.personId })).map((f) => f.name)).toEqual(["positions.csv"]);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain("A,100");
  });

  it("sends a file back on WhatsApp through a link that lasts ten minutes and can't be forged", async () => {
    const posted = stubProviders();
    const saved = await saveVersion(ORG, { name: "Model.xlsx", kind: "deliverable", bytes: Buffer.from("xlsx bytes"), personId: actor.personId });
    const tools = appTools(actor, { whatsapp: "447700900123" }) as Record<string, { execute: (input: object, options: object) => Promise<string> }>;
    expect(await tools.send_file.execute({ file: "Model.xlsx", caption: "Here it is" }, { toolCallId: "t", messages: [] })).toBe("Sent Model.xlsx on WhatsApp.");
    const form = new URLSearchParams(posted[0].body);
    expect(form.get("To")).toBe("whatsapp:+447700900123");
    expect(form.get("Body")).toBe("Here it is");
    const link = form.get("MediaUrl")!;
    expect(link).toMatch(/^https:\/\/mach\.example\/api\/files\/[\w-]+\.[\w-]+$/);

    const token = link.split("/").pop()!;
    const served = await fileByLink(new Request(link), { params: Promise.resolve({ token }) });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("xlsx bytes");
    expect(readFileLinkToken(token, Date.now() + 11 * 60_000)).toBeNull();
    const forged = `${Buffer.from(`${ORG}.${saved.versionId}.${Date.now() + 60_000}`).toString("base64url")}.${token.split(".")[1]}`;
    expect(readFileLinkToken(forged)).toBeNull();
    expect((await fileByLink(new Request(link), { params: Promise.resolve({ token: forged }) })).status).toBe(404);
    expect(readFileLinkToken(fileLinkToken(ORG, saved.versionId))).toEqual({ organizationId: ORG, versionId: saved.versionId });

    // Outside WhatsApp, it's a link to download it in the app.
    const app = appTools(actor) as typeof tools;
    expect(await app.send_file.execute({ file: "Model.xlsx" }, { toolCallId: "t", messages: [] })).toBe(`Download link: https://mach.example/files/${saved.versionId}`);
  });

  it("attaches a file to a task, only one they can see", async () => {
    stubProviders();
    await saveVersion(ORG, { name: "Model.xlsx", kind: "deliverable", bytes: Buffer.from("x"), personId: actor.personId });
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    await saveVersion(ORG, { name: "Omar's notes.txt", kind: "deliverable", bytes: Buffer.from("x"), personId: omar.id });
    const task = await createTask(ORG, { title: "Update the model", createdBy: { personId: actor.personId } });
    const tools = appTools(actor) as Record<string, { execute: (input: object, options: object) => Promise<string> }>;
    expect(await tools.attach_file.execute({ number: task.number, file: "Model.xlsx" }, { toolCallId: "t", messages: [] })).toBe(`Attached Model.xlsx to #${task.number}.`);
    expect((await listMessages(task.id)).at(-1)?.body).toBe("Attached a file from the library.");
    expect(await tools.attach_file.execute({ number: task.number, file: "Omar's notes.txt" }, { toolCallId: "t", messages: [] })).toBe(
      "Not done: There's no file called Omar's notes.txt.",
    );
  });
});
