-- Mach1 database schema. Safe to run repeatedly (pnpm db:migrate).
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

-- Jobs keep a memory (the agent's NOTES.md) and, once code has run, a
-- sandbox. Done ends a round; archiving retires the job and its sandbox.
alter table tasks add column if not exists memory text not null default '';
alter table tasks add column if not exists sandbox_name text;
alter table tasks add column if not exists archived_at timestamptz;

-- The company file library. Every deliverable an agent attaches and every
-- script it runs is a file with versions, so later jobs can build on it.
create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  name text not null,
  kind text not null default 'deliverable' check (kind in ('deliverable', 'code')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists files_org on files (organization_id, updated_at desc);

create table if not exists file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files (id) on delete cascade,
  version integer not null,
  content_type text not null,
  size integer not null,
  sha256 text not null,
  blob_pathname text, -- stored in Vercel Blob when a store is connected
  content bytea, -- otherwise stored here
  task_id uuid references tasks (id) on delete set null,
  agent_id uuid references agents (id) on delete set null,
  person_id uuid references people (id) on delete set null,
  based_on integer, -- the version this one was built from
  note text not null default '', -- e.g. "rules ABD", or a script's last run output
  created_at timestamptz not null default now()
);

create unique index if not exists file_versions_number on file_versions (file_id, version);

-- A read-only preview (sheet tables, CSV rows, text), built once when the
-- version is saved or first opened.
alter table file_versions add column if not exists preview jsonb;

-- Which library files a job works with: inputs someone attached, and outputs it produced.
create table if not exists task_files (
  task_id uuid not null references tasks (id) on delete cascade,
  file_id uuid not null references files (id) on delete cascade,
  role text not null default 'output' check (role in ('input', 'output')),
  added_at timestamptz not null default now(),
  primary key (task_id, file_id)
);

-- Prebuilt sandbox snapshots (the data stack), so job sandboxes boot ready.
create table if not exists sandbox_templates (
  key text primary key,
  snapshot_id text not null,
  created_at timestamptz not null default now()
);

-- The company's timezone (IANA name, e.g. Europe/London), for schedules. Set
-- from the first browser that opens the app; people can change it.
alter table organizations add column if not exists timezone text;

-- Recurring jobs: a schedule on the card. Each run lands on the same card and
-- works in the same sandbox. "script" replays the job's run.sh (the agent is
-- woken only if it fails, or when there is no run.sh yet); "agent" has the
-- agent do the job each time.
create table if not exists task_schedules (
  task_id uuid primary key references tasks (id) on delete cascade,
  cron text not null, -- five fields, in the schedule's timezone
  timezone text not null,
  mode text not null default 'script' check (mode in ('script', 'agent')),
  paused boolean not null default false,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by_person_id uuid references people (id) on delete set null,
  created_by_agent_id uuid references agents (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists task_schedules_due on task_schedules (next_run_at) where not paused;

-- The company data drive: shared datasets every job's sandbox sees at
-- /vercel/drive. Content lives in Vercel Blob (or here, without a store);
-- each path holds its latest content.
create table if not exists drive_files (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  path text not null, -- e.g. option-flow/2026-10-07.parquet
  content_type text not null,
  size integer not null,
  sha256 text not null,
  blob_pathname text,
  content bytea,
  task_id uuid references tasks (id) on delete set null, -- the job that last wrote it
  agent_id uuid references agents (id) on delete set null,
  person_id uuid references people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists drive_files_path on drive_files (organization_id, path);

-- Integrations: company data sources (APIs every agent can read) and website
-- logins (accounts chosen agents use in a browser). Credentials are sealed
-- with MACH_SECRETS_KEY and never shown to models or people.
create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  kind text not null check (kind in ('api', 'login')),
  slug text not null, -- the short name agents use, e.g. masttro
  name text not null,
  description text not null default '', -- what it holds or is for
  config jsonb not null default '{}'::jsonb, -- base URL, domains, how to sign requests or log in (no secrets)
  secrets bytea, -- sealed credentials
  session bytea, -- sealed: a cached access token (api) or a saved browser session (login)
  session_expires_at timestamptz,
  access text not null default 'read' check (access in ('read', 'write')),
  agent_ids uuid[], -- null: every agent; otherwise only these agents
  guide text not null default '', -- how to use it: endpoints, paging, quirks (markdown)
  status text not null default 'needs_credentials' check (status in ('needs_credentials', 'connected', 'failing', 'disabled')),
  status_detail text not null default '',
  last_checked_at timestamptz,
  last_used_at timestamptz,
  created_by_person_id uuid references people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists integrations_slug on integrations (organization_id, slug);

-- Every request made through an integration, for its activity log.
create table if not exists integration_calls (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations (id) on delete cascade,
  task_id uuid references tasks (id) on delete set null,
  agent_id uuid references agents (id) on delete set null,
  person_id uuid references people (id) on delete set null,
  method text not null,
  path text not null,
  status integer,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists integration_calls_recent on integration_calls (integration_id, created_at desc);

-- A website sign-in waiting on a person: the login it's for, and the code
-- they replied with (sealed, used once, never shown in the thread).
alter table tasks add column if not exists pending_login text;
alter table tasks add column if not exists login_code bytea;

-- People @-mentioned on a task: it shows in their Needs you until they open it.
create table if not exists task_mentions (
  task_id uuid not null references tasks (id) on delete cascade,
  person_id uuid not null references people (id) on delete cascade,
  by_name text not null, -- who mentioned them
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  primary key (task_id, person_id)
);

-- Files attached to a message in a task's thread (they're also on the task, as inputs).
create table if not exists task_message_files (
  message_id uuid not null references task_messages (id) on delete cascade,
  version_id uuid not null references file_versions (id) on delete cascade,
  primary key (message_id, version_id)
);

-- A run's live status: when it began and what the agent is doing now ("Running summarise.py").
alter table tasks add column if not exists run_began_at timestamptz;
alter table tasks add column if not exists run_activity text not null default '';

-- How long the run took, on an agent's result: shown as "Done in 4m 12s".
alter table task_messages add column if not exists duration_ms integer;

-- An agent's reaction to a message in the thread: 👀 when it picks the message
-- up, then ✅ done, 💬 asked, 🤝 handed off or ⚠️ hit a problem.
create table if not exists task_message_reactions (
  message_id uuid not null references task_messages (id) on delete cascade,
  agent_id uuid not null references agents (id) on delete cascade,
  emoji text not null,
  updated_at timestamptz not null default now(),
  primary key (message_id, agent_id)
);

-- The company's email address for the Chief of Staff (an AgentMail inbox id, which is the address).
alter table organizations add column if not exists email_inbox text;
create unique index if not exists organizations_email_inbox on organizations (lower(email_inbox)) where email_inbox is not null;

-- Messages from WhatsApp and email already handled, so a provider's retry isn't answered twice.
create table if not exists inbound_messages (
  provider text not null,
  external_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, external_id)
);

-- Pages: views of the company's data that people ask the Chief of Staff for,
-- shown as tabs on Home. A page is HTML (every version kept) that reads files
-- on the company drive; a recurring job usually keeps those files fresh.
create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  slug text not null,
  title text not null,
  description text not null default '',
  data text[] not null default '{}', -- the drive paths it reads
  task_id uuid references tasks (id) on delete set null, -- the job that refreshes its data
  pinned boolean not null default true, -- a tab on Home
  created_by_person_id uuid references people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pages_slug on pages (organization_id, slug);

create table if not exists page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages (id) on delete cascade,
  version integer not null,
  html text not null,
  sha256 text not null,
  note text not null default '',
  by_name text not null default '',
  person_id uuid references people (id) on delete set null,
  agent_id uuid references agents (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists page_versions_number on page_versions (page_id, version);

-- A quiet recurring job only reaches someone's inbox when a run fails (a page's
-- data refresh): runs that work are noted on its thread and leave it done.
alter table task_schedules add column if not exists quiet boolean not null default false;

-- Ideas for pages, written for each company from its profile, its integrations
-- and the pages it has. Kept until any of those change (inputs_sha256).
create table if not exists page_ideas (
  organization_id text primary key references organizations (id) on delete cascade,
  inputs_sha256 text not null,
  ideas jsonb not null,
  created_at timestamptz not null default now()
);

-- A Chief of Staff reply keeps going when its browser disconnects (a closed
-- panel, a reload); the Stop button asks for it to stop through this.
alter table chats add column if not exists stop_requested_at timestamptz;

-- A phone or browser that gets Mach1's push notifications for a person: when a
-- task starts waiting on them or is ready for their review, or someone
-- @-mentions them. One row per device and person (a device can be signed in
-- to two companies). Gone when the push service says the device unsubscribed.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  person_id uuid not null references people (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  unique (endpoint, person_id)
);

create index if not exists push_subscriptions_person on push_subscriptions (person_id);

-- Colleagues with the company's work email domain join on their own when an
-- admin turns this on; otherwise they ask, and an admin lets them in.
alter table organizations add column if not exists auto_join boolean not null default false;

-- A colleague asking to join is a task in the admins' inbox ("join_request").
alter table tasks drop constraint if exists tasks_kind_check;
alter table tasks add constraint tasks_kind_check check (kind in ('task', 'suggestion', 'join_request'));

-- Webhooks Mach1 registers with a service itself (AgentMail's, for incoming
-- email): one per API key ("agentmail:<hash of the key>"), so changing the key
-- (a new account) registers a new one. The signing secret is sealed.
create table if not exists service_webhooks (
  service text primary key,
  url text not null,
  webhook_id text not null,
  secret bytea not null,
  created_at timestamptz not null default now()
);

-- A person's "Send now" while an agent works: the run stops at its next step and starts again with their message.
alter table tasks add column if not exists interrupt_requested_at timestamptz;
-- While a Chief of Staff reply is running for a chat (cleared when it's saved), so a message sent with
-- Send now waits for the reply it stopped to save first.
alter table chats add column if not exists reply_started_at timestamptz;

-- Conversations with the browser agent: a worker or the Chief of Staff gives it a browser job and can
-- come back to the same session (same browser, same history) with follow-ups or answers it asked for.
create table if not exists browser_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  task_id uuid references tasks (id) on delete cascade,
  goal text not null,
  messages jsonb not null default '[]',
  status text not null default 'working' check (status in ('working', 'done', 'needs_input', 'blocked', 'failed')),
  login text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists browser_sessions_org on browser_sessions (organization_id, updated_at desc);

-- Whose Chief of Staff chat a browser session belongs to (sessions on a task belong to the task).
alter table browser_sessions add column if not exists person_id uuid references people (id) on delete cascade;

-- WhatsApp numbers people proved are theirs: they sent a one-time LINK code from the number to Mach1's
-- WhatsApp sender (WhatsApp vouches for who sent it). Only these numbers reach the Chief of Staff;
-- people.phone is contact details anyone may edit, never used to decide who a message is from.
alter table people add column if not exists whatsapp text;
alter table people add column if not exists whatsapp_linked_at timestamptz;
create index if not exists people_whatsapp on people (whatsapp) where whatsapp is not null;

create table if not exists whatsapp_links (
  code text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  person_id uuid not null references people (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- The Integrations agent: one built-in agent per company that connects its systems, each on its own task.
alter table agents add column if not exists builtin text;
-- The task whose agent set an integration up: it isn't finished until the integration works.
alter table integrations add column if not exists setup_task_id uuid references tasks (id) on delete set null;
-- A thread message that carries an integration's credentials card.
alter table task_messages add column if not exists integration_id uuid references integrations (id) on delete set null;

-- Each person's own accounts elsewhere (GitHub first), connected by them and used only for their own work:
-- the Chief of Staff chatting with them and task runs they asked for. Tokens are sealed (lib/secrets.ts).
create table if not exists personal_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  person_id uuid not null references people (id) on delete cascade,
  provider text not null check (provider in ('github')),
  account_id text not null,
  account_login text not null,
  account_name text not null default '',
  secrets bytea not null,
  status text not null default 'connected' check (status in ('connected', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists personal_connections_person on personal_connections (person_id, provider);

-- A task asked for over WhatsApp: when it's ready or needs an answer, the person who asked hears on WhatsApp.
alter table tasks add column if not exists reply_by_whatsapp boolean not null default false;

-- What a person's assistant (the Chief of Staff talking with them) knows about them: preferences, what
-- they look after, what it's following up on. Only it reads these, and only while talking with them.
alter table people add column if not exists memory text not null default '';

-- Long conversations: the model sees the latest messages in full and a summary of everything before.
alter table chats add column if not exists summary text not null default '';
alter table chats add column if not exists summarized_through text; -- the id of the last message the summary covers

-- Who can see a task: everyone in the company, or (private) only whoever created it, the people on it
-- and anyone @-mentioned on it. Tasks from before this are company tasks.
alter table tasks add column if not exists visibility text not null default 'company' check (visibility in ('company', 'private'));

-- Who can see a file in the library: the company, or (private) its owner and anyone who can see a task
-- it's on. A page: the company, or (private) whoever made it. Files and pages from before are the company's.
alter table files add column if not exists visibility text not null default 'company' check (visibility in ('company', 'private'));
alter table files add column if not exists owner_person_id uuid references people (id) on delete set null;
alter table pages add column if not exists visibility text not null default 'company' check (visibility in ('company', 'private'));

-- Which people may use an integration (through their assistant and the work it does for them): null is everyone.
alter table integrations add column if not exists person_ids uuid[];

-- When a person's assistant may message them first: their timezone (else the company's) and working and
-- quiet hours (lib/assistant/hours.ts). WhatsApp only lets a business write freely within 24 hours of the
-- person's last message, so the last one in and the assistant's last unprompted message are kept too.
alter table people add column if not exists timezone text;
alter table people add column if not exists work_hours jsonb;
alter table people add column if not exists whatsapp_in_at timestamptz;
alter table people add column if not exists assistant_nudged_at timestamptz;

-- Moments a person's assistant wakes up by itself (lib/assistant/wake.ts): work of theirs that's done or
-- needs them, a check-in it set itself, or a keep-alive before WhatsApp's 24-hour window closes. A due
-- wake-up is claimed by one cron tick, and done once its turn has run.
create table if not exists assistant_wakeups (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  person_id uuid not null references people (id) on delete cascade,
  reason text not null check (reason in ('task', 'check_in', 'keepalive')),
  note text not null default '',
  task_id uuid references tasks (id) on delete cascade,
  urgent boolean not null default false,
  due_at timestamptz not null,
  claimed_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists assistant_wakeups_due on assistant_wakeups (due_at) where done_at is null;
create index if not exists assistant_wakeups_person on assistant_wakeups (person_id, created_at desc);

-- The model an agent runs on (an AI Gateway id such as anthropic/claude-sonnet-4.5), chosen for its work:
-- null takes the default for its kind (CODING_AGENT_MODEL for the Developer, else AGENT_MODEL).
alter table agents add column if not exists model text;

-- Bring your own key: a company's own accounts with AI providers (Anthropic, OpenAI, …), sealed like
-- integration credentials (lib/secrets.ts). Every model call made for the company carries them to AI Gateway
-- for that one request (lib/ai), so its usage is billed to its own provider accounts.
create table if not exists ai_keys (
  organization_id text not null references organizations (id) on delete cascade,
  provider text not null,
  secrets bytea not null,
  hint text not null default '', -- the key's last four characters, to tell keys apart
  added_by_person_id uuid references people (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (organization_id, provider)
);

-- The company's own choice of models (AI Gateway ids): { "chiefOfStaff": …, "agents": … }. Empty uses Mach1's.
alter table organizations add column if not exists models jsonb not null default '{}';

-- People join a company only by invitation now: requests to join by email domain are closed, and the
-- domain and auto-join columns are no longer read (kept so nothing is lost).
update tasks set status = 'cancelled', options = '[]'::jsonb, updated_at = now()
where kind = 'join_request' and status not in ('done', 'cancelled');

-- The sources people trust most for research (lib/research/sources.ts): a website, an X account, a subreddit
-- or a Reddit user, with why it's worth reading. The Researcher (and any agent researching for them) looks
-- there first and weighs it higher. Private to whoever saved it, or the company's for everyone's research.
create table if not exists research_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations (id) on delete cascade,
  kind text not null check (kind in ('website', 'x_account', 'subreddit', 'reddit_user')),
  handle text not null, -- ft.com, DeItaone, investing, DeepFuckingValue: no @, r/ or u/
  note text not null default '',
  visibility text not null default 'private' check (visibility in ('company', 'private')),
  owner_person_id uuid references people (id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists research_sources_unique
  on research_sources (organization_id, coalesce(owner_person_id::text, ''), kind, lower(handle));
