import { BadgeCheck } from "lucide-react";

import { EditableText } from "@/app/(app)/team/team-controls";
import { AccountPreferences } from "@/components/account-preferences";
import { WhatsAppNumber } from "@/components/channel-settings";
import { SettingRow, SettingsGroup } from "@/components/setting-row";
import { whatsappNumber } from "@/lib/channels/twilio";
import { formatPhone } from "@/lib/phone-format";
import { requireAppContext } from "@/lib/session";

// Settings → Account: your own profile (the same details, and the same
// editing, as your row on the Team page), your WhatsApp link, and this
// browser's preferences.
export default async function AccountSettingsPage() {
  const { person, user } = await requireAppContext();
  return (
    <>
      <SettingsGroup title="Your profile" description="What the team and the Chief of Staff know about you. It's the same as your row on the Team page.">
        <SettingRow title="Name" description={<EditableText personId={person.id} field="name" value={person.name} label="Name" placeholder="Your name" />} />
        <SettingRow title="Email" description={<span title="The address you sign in with">{user.email}</span>} />
        <SettingRow title="Role" description={<EditableText personId={person.id} field="role" value={person.role} label="Role" placeholder="Add your role" />} />
        <SettingRow
          title="Responsibilities"
          description={
            <EditableText
              personId={person.id}
              field="responsibilities"
              value={person.responsibilities}
              label="Responsibilities"
              placeholder="What you look after"
              multiline
            />
          }
        />
        <SettingRow
          title="Phone"
          description={
            person.whatsapp ? (
              <span className="inline-flex items-center gap-1 font-mono text-ink" title="Your linked WhatsApp number">
                {formatPhone(person.whatsapp)}
                <BadgeCheck size={13} className="text-ok" aria-label="Verified" />
              </span>
            ) : (
              <EditableText personId={person.id} field="phone" value={person.phone ?? ""} label="Phone" placeholder="Add your phone" />
            )
          }
        />
        <WhatsAppNumber whatsapp={whatsappNumber()} linked={person.whatsapp} />
      </SettingsGroup>
      <SettingsGroup title="This browser">
        <AccountPreferences />
      </SettingsGroup>
    </>
  );
}
