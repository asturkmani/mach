import { EmailChannel, WhatsAppChannel } from "@/components/channel-settings";
import { SettingsGroup } from "@/components/setting-row";
import { agentmailConfigured } from "@/lib/channels/agentmail";
import { whatsappNumber } from "@/lib/channels/twilio";
import { requireAppContext } from "@/lib/session";

// Settings → Channels: how the team reaches the Chief of Staff outside Mach.
export default async function ChannelsSettingsPage() {
  const { organization, person, isAdmin } = await requireAppContext();
  return (
    <SettingsGroup
      title="Channels"
      description="Talk to the Chief of Staff from your inbox or your phone. It's the same conversation as the chat panel."
    >
      <EmailChannel
        emailInbox={organization.emailInbox}
        email={person.email ?? ""}
        emailAvailable={agentmailConfigured()}
        isAdmin={isAdmin}
      />
      <WhatsAppChannel whatsapp={whatsappNumber()} isAdmin={isAdmin} />
    </SettingsGroup>
  );
}
