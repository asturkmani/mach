import { PageBody, Section } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { BaseSkills, CompanySkills, Proposals, WriteSkillForm } from "@/components/skills";
import { SKILLS } from "@/lib/agents/skills";
import { listCompanySkills, listSkillVersions } from "@/lib/company-skills";
import { pendingProposals } from "@/lib/learning/proposals";
import { getTask } from "@/lib/tasks";
import { requireAppContext } from "@/lib/session";

// @map Skills | Left menu → Skills | Changes Mach1 proposes after finished work, to apply or skip; the company's own skills (how it does its work and how its systems work) with every version, restoring, sharing, retiring and writing a new one; and Mach1's skills.
export default async function SkillsPage() {
  const { organization, person, isAdmin } = await requireAppContext();
  const own = await listCompanySkills(organization.id, { viewer: person.id });
  const waiting = await Promise.all(
    (await pendingProposals(organization.id, person.id)).map(async (p) => ({
      from: p.messageNumber ?? 0,
      number: p.number,
      why: p.why,
      what: p.change.target === "skill" ? `${p.change.isNew ? "New skill" : "Skill"} · ${p.change.name}` : `Company profile · ${p.change.section}`,
      text: p.change.target === "skill" ? `${p.change.description}\n\n${p.change.body}` : p.change.content,
      sourceNumber: p.taskId ? ((await getTask(organization.id, p.taskId))?.number ?? null) : null,
    })),
  );
  const skills = await Promise.all(
    own.map(async (s) => ({
      name: s.name,
      kind: s.kind,
      description: s.description,
      body: s.body,
      extends: s.extends,
      scripts: Object.keys(s.scripts),
      owner: s.ownerName,
      visibility: s.visibility,
      version: s.version,
      updatedAt: new Date(s.updatedAt).toISOString(),
      canChange: s.ownerPersonId === person.id || (isAdmin && (s.ownerPersonId === null || s.visibility === "company")),
      versions: (await listSkillVersions(s.id)).map((v) => ({
        version: v.version,
        note: v.note,
        author: v.author,
        taskNumber: v.sourceTaskNumber,
        at: new Date(v.createdAt).toISOString(),
      })),
    })),
  );

  return (
    <>
      <PageHeader title="Skills" />
      <PageBody width="4xl" className="space-y-12">
        {waiting.length > 0 && (
          <section>
            <h2 className="label mb-3">
              Waiting on your yes <span className="text-faint">{waiting.length}</span>
            </h2>
            <p className="-mt-1 mb-3 text-sm text-muted">
              What Mach1 learned from finished work. Each is applied only if you say yes; you can also answer your Chief of Staff in words.
            </p>
            <Proposals proposals={waiting} />
          </section>
        )}
        <Section
          title="The company's skills"
          count={skills.length}
          addLabel="Write a skill"
          description={
            <>
              How this company does its work, and how its systems work. Agents load the ones a job needs. After a job, Mach1 proposes what to
              keep or change, and you apply it with a yes. Or tell your Chief of Staff, e.g. &ldquo;here&apos;s how we do month-end, save it&rdquo;.
            </>
          }
          form={<WriteSkillForm bases={SKILLS.map((s) => s.name)} />}
        >
          {skills.length === 0 ? (
            <p className="text-sm text-faint">None yet. They&apos;re learned on the job, or written here.</p>
          ) : (
            <CompanySkills skills={skills} />
          )}
        </Section>

        <section>
          <h2 className="label mb-3">Mach1&apos;s skills</h2>
          <p className="-mt-1 mb-3 text-sm text-muted">Kinds of work every company&apos;s agents know. A skill of the company&apos;s can extend one with its own way.</p>
          <BaseSkills skills={SKILLS.map((s) => ({ name: s.name, description: s.description, body: s.body }))} />
        </section>
      </PageBody>
    </>
  );
}
