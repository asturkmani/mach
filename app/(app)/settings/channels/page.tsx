import { EmailChannel, WhatsAppChannel } from "@/components/channel-settings";
import { SettingsGroup } from "@/components/setting-row";
import { agentmailConfigured, ensureEmailWebhook, inboxExists } from "@/lib/channels/agentmail";
import { setEmailInbox } from "@/lib/orgs";
import { whatsappNumber } from "@/lib/channels/twilio";
import { requireAppContext } from "@/lib/session";

// @map Settings → Channels | Company menu → Settings → Channels | Reaching the Chief of Staff outside Mach1: the company's email address and Mach1's WhatsApp number.
// Settings → Channels: how the team reaches the Chief of Staff outside Mach1.
export default async function ChannelsSettingsPage() {
  const { organization, person, isAdmin } = await requireAppContext();
  let emailInbox = organization.emailInbox;
  let moved = false;
  if (agentmailConfigured()) {
    // Incoming email reaches this app on whichever AgentMail account the key belongs to.
    if (isAdmin) await ensureEmailWebhook().catch((error) => console.error("Couldn't register the email webhook", error));
    // An address from an account Mach1 no longer uses can't receive or send: set up a new one.
    if (emailInbox && !(await inboxExists(emailInbox).catch(() => true))) {
      await setEmailInbox(organization.id, null);
      moved = true;
      emailInbox = null;
    }
  }
  return (
    <SettingsGroup
      title="Channels"
      description="Talk to the Chief of Staff from your inbox or your phone. It's the same conversation as the chat panel."
    >
      <EmailChannel
        emailInbox={emailInbox}
        moved={moved}
        email={person.email ?? ""}
        emailAvailable={agentmailConfigured()}
        isAdmin={isAdmin}
      />
      <WhatsAppChannel whatsapp={whatsappNumber()} isAdmin={isAdmin} />
    </SettingsGroup>
  );
}
