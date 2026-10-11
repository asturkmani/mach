import { PageBody, Section } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { BaseSkills, CompanySkills, WriteSkillForm } from "@/components/skills";
import { SKILLS } from "@/lib/agents/skills";
import { listCompanySkills, listSkillVersions } from "@/lib/company-skills";
import { requireAppContext } from "@/lib/session";

// @map Skills | Left menu → Skills | The company's own skills (how it does its work and how its systems work) with every version, restoring, sharing, retiring and writing a new one; and Mach1's skills.
export default async function SkillsPage() {
  const { organization, person, isAdmin } = await requireAppContext();
  const own = await listCompanySkills(organization.id, { viewer: person.id });
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
