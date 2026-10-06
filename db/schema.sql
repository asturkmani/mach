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
