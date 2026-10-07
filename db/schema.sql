-- Mach database schema. Safe to run repeatedly (pnpm db:migrate).
-- Users, logins, org memberships and invitations live in WorkOS; these tables
-- hold everything else, keyed by the WorkOS organization id.

create table if not exists organizations (
  id text primary key, -- WorkOS organization id
  name text not null,
  website text,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- The creator's work email domain (e.g. cedarlegacy.com), so colleagues who
-- sign up later are pointed to the existing company instead of creating a
-- duplicate. Null when the creator used a personal address like gmail.com.
alter table organizations add column if not exists domain text;
create unique index if not exists organizations_domain on organizations (lower(domain)) where domain is not null;

-- The company profile is one markdown document per organization.
create table if not exists company_profiles (
  organization_id text primary key references organizations (id) on delete cascade,
  markdown text not null,
  updated_at timestamptz not null default now()
);

-- Everyone in the org chart, whether or not they have a login yet.
create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  name text not null,
  role text not null default '',
  responsibilities text not null default '',
  email text,
  phone text,
  manager_id uuid references people (id) on delete set null,
  status text not null default 'not_invited' check (status in ('not_invited', 'invited', 'active')),
  workos_user_id text,
  workos_invitation_id text,
  invite_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists people_org_name on people (organization_id, lower(name));
create unique index if not exists people_org_email on people (organization_id, lower(email)) where email is not null;
create unique index if not exists people_org_user on people (organization_id, workos_user_id) where workos_user_id is not null;

-- One Chief of Staff conversation per person per organization, stored in the
-- AI SDK's UI message format.
create table if not exists chats (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  user_id text not null, -- WorkOS user id
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists chats_org_user on chats (organization_id, user_id);

-- Agents other than the Chief of Staff. "defined" agents have a standing
-- profile and do the same kind of work again and again (sales outbound,
-- financial analysis); "worker" agents are made for one task and archived
-- when it ends.
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  kind text not null check (kind in ('defined', 'worker')),
  name text not null,
  role text not null default '',
  description text not null default '', -- what it's responsible for and what good looks like
  instructions text not null default '', -- detailed do's and don'ts
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agents_org_name on agents (organization_id, lower(name)) where status <> 'archived';

-- Jobs. Any mix of people and agents can be on one; agents on a task see all
-- of it (description, summary, members and the whole thread) when they run.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  number integer not null, -- shown as #12, counted per organization
  kind text not null default 'task' check (kind in ('task', 'suggestion')),
  title text not null,
  description text not null default '',
  summary text not null default '', -- one sentence: what happened and what's needed now
  context text not null default '', -- a few sentences that bring the task back to someone who forgot it
  progress text not null default '', -- steps done so far, one per line
  status text not null default 'ready' check (status in ('backlog', 'ready', 'in_progress', 'waiting', 'review', 'done', 'cancelled')),
  priority text not null default 'medium' check (priority in ('urgent', 'high', 'medium', 'low')),
  options jsonb not null default '[]'::jsonb, -- answers to the current ask: [{ "label": "...", "recommended": true }]
  payload jsonb, -- for suggestions: the profile change waiting to be applied
  later_until timestamptz, -- put off until then
  created_by_person_id uuid references people (id) on delete set null,
  created_by_agent_id uuid references agents (id) on delete set null,
  run_agent_id uuid references agents (id) on delete set null, -- the agent running now
  run_started_at timestamptz, -- lease: a run older than this is considered dead
  agent_turns integer not null default 0, -- agent runs since a person last spoke, to stop hand-off loops
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists tasks_org_number on tasks (organization_id, number);
create index if not exists tasks_org_status on tasks (organization_id, status);

create table if not exists task_members (
  task_id uuid not null references tasks (id) on delete cascade,
  person_id uuid references people (id) on delete cascade,
  agent_id uuid references agents (id) on delete cascade,
  added_at timestamptz not null default now(),
  check ((person_id is null) <> (agent_id is null))
);

create unique index if not exists task_members_person on task_members (task_id, person_id) where person_id is not null;
create unique index if not exists task_members_agent on task_members (task_id, agent_id) where agent_id is not null;

-- The task's thread: comments, agent updates, questions, results and events.
create table if not exists task_messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  person_id uuid references people (id) on delete set null,
  agent_id uuid references agents (id) on delete set null,
  author text not null, -- name at the time, so the thread survives renames and removals
  kind text not null default 'comment' check (kind in ('comment', 'update', 'ask', 'result', 'event')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists task_messages_task on task_messages (task_id, created_at);

-- Files an agent produced for a task, such as a model as CSV or a report as markdown.
create table if not exists task_outputs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  agent_id uuid references agents (id) on delete set null,
  filename text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists task_outputs_name on task_outputs (task_id, lower(filename));
