import { AccountPreferences } from "@/components/account-preferences";
import { WhatsAppNumber } from "@/components/channel-settings";
import { SettingRow, SettingsGroup } from "@/components/setting-row";
import { whatsappNumber } from "@/lib/channels/twilio";
import { requireAppContext } from "@/lib/session";

// Settings → Account: you, your WhatsApp number, and this browser's preferences.
export default async function AccountSettingsPage() {
  const { person, user } = await requireAppContext();
  return (
    <SettingsGroup title="Account">
      <SettingRow title="Name" description={person.name} />
      <SettingRow title="Email" description={user.email} />
      <WhatsAppNumber whatsapp={whatsappNumber()} phone={person.phone} />
      <AccountPreferences />
    </SettingsGroup>
  );
}
