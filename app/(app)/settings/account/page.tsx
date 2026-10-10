import { BadgeCheck } from "lucide-react";

import { EditableText } from "@/app/(app)/team/team-controls";
import { AccountPreferences } from "@/components/account-preferences";
import { WhatsAppNumber } from "@/components/channel-settings";
import { GitHubConnection } from "@/components/github-connection";
import { PersonalNotes } from "@/components/personal-notes";
import { WorkHoursSetting } from "@/components/work-hours";
import { SettingRow, SettingsGroup } from "@/components/setting-row";
import { whatsappNumber } from "@/lib/channels/twilio";
import { getPersonalMemory } from "@/lib/agents/conversation";
import { getAssistantHours } from "@/lib/assistant/store";
import { getGitHubConnection, githubConfigured, githubInstallUrl } from "@/lib/github";
import { formatPhone } from "@/lib/phone-format";
import { requireAppContext } from "@/lib/session";

// @map Settings → Account | Your menu (bottom left) → Account settings | Your own profile, your WhatsApp link, your working and quiet hours, what your assistant knows about you, your GitHub, and this browser's preferences.
// Settings → Account: your own profile (the same details, and the same
// editing, as your row on the Team page), your WhatsApp link, your own
// accounts elsewhere (GitHub), and this browser's preferences.
export default async function AccountSettingsPage({ searchParams }: PageProps<"/settings/account">) {
  const { organization, person, user } = await requireAppContext();
  const [github, params, notes, hours] = await Promise.all([
    getGitHubConnection(organization.id, person.id),
    searchParams,
    getPersonalMemory(organization.id, person.id),
    getAssistantHours(organization.id, person.id),
  ]);
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
      <SettingsGroup
        title="Your hours"
        description="When the Chief of Staff may message you first: finished work in your working hours, anything that needs you any time but your quiet hours."
      >
        <div className="py-4">
          <WorkHoursSetting timezone={hours.timezone} hours={hours.hours} saved={hours.saved} />
        </div>
      </SettingsGroup>
      <SettingsGroup
        title="What your assistant knows about you"
        description="Notes the Chief of Staff keeps as it gets to know you, and reads only while talking with you. Nobody else sees them."
      >
        <div className="py-4">
          <PersonalNotes notes={notes} />
        </div>
      </SettingsGroup>
      <SettingsGroup
        title="Your accounts"
        description="Accounts elsewhere that are yours alone. Agents use them only for work you ask for, never for anyone else's."
      >
        <GitHubConnection
          configured={githubConfigured()}
          account={github && { login: github.login, name: github.name, status: github.status }}
          installUrl={githubInstallUrl()}
          outcome={typeof params.github === "string" ? params.github : undefined}
        />
      </SettingsGroup>
      <SettingsGroup title="This browser">
        <AccountPreferences />
      </SettingsGroup>
    </>
  );
}
