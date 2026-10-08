// Registers the webhook AgentMail posts incoming email to, and prints its signing
// secret for AGENTMAIL_WEBHOOK_SECRET. Run once per deployment:
//   pnpm email:webhook https://<your-domain>/api/email
const url = process.argv[2];
if (!url?.startsWith("https://") || !url.endsWith("/api/email")) {
  console.error("Usage: pnpm email:webhook https://<your-domain>/api/email");
  process.exit(1);
}
if (!process.env.AGENTMAIL_API_KEY) {
  console.error("Set AGENTMAIL_API_KEY first.");
  process.exit(1);
}
const response = await fetch("https://api.agentmail.to/v0/webhooks", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.AGENTMAIL_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url, event_types: ["message.received"] }),
});
if (!response.ok) {
  console.error(`AgentMail said ${response.status}: ${await response.text()}`);
  process.exit(1);
}
const webhook = await response.json();
console.log(`Webhook ${webhook.webhook_id} → ${url}`);
console.log("Set this as AGENTMAIL_WEBHOOK_SECRET (in Vercel and .env.local):");
console.log(webhook.secret);
