# Talking to the Chief of Staff on WhatsApp and email

People can talk to the Chief of Staff outside the app: on WhatsApp from their own number, and by email to their company's Chief of Staff address. Both channels reach the same Chief of Staff, with the same tools. They also share the conversation with the chat panel: a WhatsApp message and its reply show up in the panel, and a conversation started in the panel can continue on WhatsApp.

## Who gets an answer

Only people who have joined their company in Mach1 (signed in at least once) get an answer.

- **WhatsApp:** the sender's number must match the WhatsApp number a person saved in Settings → Account. Spaces, `+` and a leading `00` don't matter, but the country code does.
  - A number that isn't linked gets one reply explaining how to link it. The Chief of Staff isn't run for it.
  - Someone in several companies reaches the company they last talked to the Chief of Staff in.
- **Email:** the sender's address must be a team member's email in that company.
  - Mail from anyone else gets no reply, which also avoids sending mail back to spoofed senders.
  - Only mail that passed the sender's authentication is answered. AgentMail labels the rest `message.received.unauthenticated`, `.spam` or `.blocked`, so a spoofed "From" doesn't reach the Chief of Staff.

## How a message flows

1. **The provider posts the message:** Twilio to `/api/whatsapp`, AgentMail to `/api/email`.
2. **The signature is checked:**
   - Twilio's `X-Twilio-Signature` is an HMAC-SHA1 of the URL and the sorted form parameters, signed with the auth token.
   - AgentMail's Svix headers carry an HMAC-SHA256 of `id.timestamp.body`, and must be less than five minutes old.
   - Both checks were verified against the official `twilio` and `svix` libraries.
3. **Retries are dropped:** each message id is handled once (the `inbound_messages` table).
4. **The request returns straight away.** Twilio waits only 15 seconds for an answer. The Chief of Staff then runs in `after()`, within the route's 300-second limit, in the person's conversation (`lib/agents/cos-turn.ts`).
5. **The reply goes out:**
   - **WhatsApp:** through Twilio's Messages API. Markdown is turned into WhatsApp formatting (`*bold*`, tables as lines), and long replies are split at paragraphs into parts of up to 1,500 characters.
   - **Email:** in the same thread, through AgentMail's reply endpoint. The Chief of Staff reads only the new part of an email (AgentMail's `extracted_text`), not the quoted thread below it.

**What the Chief of Staff is told:** the message came by WhatsApp or email, so it keeps replies short. Cards (credentials for an integration, a sign-in code, a profile suggestion) only work in the app, so it gives a link to finish there instead.

**Voice notes** on WhatsApp are transcribed (the same model as voice messages in the app, see below) and answered like a typed message. The Chief of Staff is told the words were transcribed, so it double-checks names and numbers before acting on them. If a voice note can't be transcribed, it asks for it again or typed.

**Other attachments** sent on WhatsApp or by email aren't read yet. The Chief of Staff is told they arrived, and asks for them to be attached on a task in Mach1.

**Voice messages in the app:** the microphone next to the paperclip, in the chat panel and in a task's reply box, records a message. It's transcribed into the message box for you to check and send; the recording isn't kept. Transcription goes through the AI Gateway (xAI's `spacexai/grok-stt` by default, about $0.0017 a minute and under a second for a short message; set `TRANSCRIPTION_MODEL` for another), up to 5 minutes or 20MB a message. Esc while recording throws it away.

## Setting it up

### WhatsApp (Twilio)

1. **Get a WhatsApp sender in Twilio.** For testing, Twilio's WhatsApp sandbox works: each person first sends its "join …" code to the sandbox number. For real use, register a WhatsApp sender for your number.
2. **Point Twilio at Mach1.** Set the sender's "When a message comes in" webhook to `https://<your-domain>/api/whatsapp` (HTTP POST).
3. **Add the variables to Vercel:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (e.g. `whatsapp:+14155238886`) and `APP_URL`.
4. **Each person links their number.** In Settings → Account, they add their WhatsApp number.

The signature check uses the URL Twilio called. Behind a proxy that changes the host, set `TWILIO_WEBHOOK_URL` to the exact URL configured in Twilio.

### Email (AgentMail)

1. **Get an API key:** add AgentMail from the Vercel Marketplace and connect it to the project, which sets `AGENTMAIL_API_KEY`. An account made on agentmail.to works too, with the key set by hand.
2. **The webhook registers itself.** When an admin opens Settings → Channels (or creates the company's address), Mach1 checks that AgentMail posts incoming email to `APP_URL/api/email` on the key's account, and registers the webhook if it doesn't. Its signing secret is kept sealed in the database (`service_webhooks`, one row per key), so a new key, or a new account, needs nothing else. `AGENTMAIL_WEBHOOK_SECRET` is still accepted, for a webhook registered by hand with `pnpm email:webhook`.
3. **Create the company's address:** an admin clicks "Create address" in Settings → Channels. That creates an AgentMail inbox named after the company, e.g. `cedar-legacy@agentmail.to`, with a number added if the name is taken. An address left on an AgentMail account Mach1 no longer uses (after moving to a new one) is noticed there and cleared, so the admin can create a new one.

Deleting a company deletes its inbox too.

## Not built yet

- **Messages the Chief of Staff starts**, e.g. "something needs you" on WhatsApp. WhatsApp only allows a business to start a conversation with pre-approved templates, so this needs one.
- **Reading attachments** sent on WhatsApp or by email.
- **A custom email domain** (`chief@cedarlegacy.com`). AgentMail supports one; Mach1 uses `@agentmail.to` addresses for now.

## Code

| Path | What it is |
|---|---|
| `app/api/whatsapp/route.ts`, `app/api/email/route.ts` | The webhooks: signature checks, retries, replying in the background |
| `lib/channels/inbound.ts` | From a message to a reply: who it's from, the Chief of Staff's turn, sending it back |
| `lib/channels/senders.ts` | Matching a number or an address to a person; handled message ids |
| `lib/channels/twilio.ts`, `lib/channels/agentmail.ts` | The providers: signatures, sending, inboxes, WhatsApp formatting |
| `lib/agents/cos-turn.ts` | One Chief of Staff turn, shared by the chat panel and both channels |
| `components/channel-settings.tsx` | The Settings rows: the company's email address and WhatsApp sender (Channels), your WhatsApp number (Account) |
| `scripts/agentmail-webhook.mjs` | Registers AgentMail's webhook by hand and prints its secret (Mach1 normally does it itself) |
