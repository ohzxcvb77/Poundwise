-- Poundwise family sharing and device sync schema
-- Run this entire file once in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.poundwise_households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 60),
  invite_code text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.poundwise_household_members (
  household_id uuid not null references public.poundwise_households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  display_name text not null check (char_length(trim(display_name)) between 1 and 30),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.poundwise_household_settings (
  household_id uuid primary key references public.poundwise_households(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.poundwise_transactions (
  id text primary key,
  household_id uuid not null references public.poundwise_households(id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  amount numeric not null check (amount > 0),
  currency text not null check (currency in ('GBP', 'KRW')),
  date date not null,
  category text not null default 'Other',
  memo text not null default '' check (char_length(memo) <= 100),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists poundwise_members_user_idx
  on public.poundwise_household_members(user_id);
create index if not exists poundwise_transactions_household_date_idx
  on public.poundwise_transactions(household_id, date desc);
create index if not exists poundwise_transactions_updated_idx
  on public.poundwise_transactions(household_id, updated_at desc);

create or replace function public.poundwise_is_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.poundwise_household_members member
    where member.household_id = p_household_id
      and member.user_id = (select auth.uid())
  );
$$;

create or replace function public.poundwise_is_owner(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.poundwise_households household
    where household.id = p_household_id
      and household.owner_id = (select auth.uid())
  );
$$;

alter table public.poundwise_households enable row level security;
alter table public.poundwise_household_members enable row level security;
alter table public.poundwise_household_settings enable row level security;
alter table public.poundwise_transactions enable row level security;

drop policy if exists "poundwise members view households" on public.poundwise_households;
create policy "poundwise members view households"
  on public.poundwise_households for select to authenticated
  using ((select public.poundwise_is_member(id)));

drop policy if exists "poundwise owners update households" on public.poundwise_households;
create policy "poundwise owners update households"
  on public.poundwise_households for update to authenticated
  using ((select public.poundwise_is_owner(id)))
  with check ((select public.poundwise_is_owner(id)));

drop policy if exists "poundwise members view members" on public.poundwise_household_members;
create policy "poundwise members view members"
  on public.poundwise_household_members for select to authenticated
  using ((select public.poundwise_is_member(household_id)));

drop policy if exists "poundwise members view settings" on public.poundwise_household_settings;
create policy "poundwise members view settings"
  on public.poundwise_household_settings for select to authenticated
  using ((select public.poundwise_is_member(household_id)));

drop policy if exists "poundwise members create settings" on public.poundwise_household_settings;
create policy "poundwise members create settings"
  on public.poundwise_household_settings for insert to authenticated
  with check ((select public.poundwise_is_member(household_id)));

drop policy if exists "poundwise members update settings" on public.poundwise_household_settings;
create policy "poundwise members update settings"
  on public.poundwise_household_settings for update to authenticated
  using ((select public.poundwise_is_member(household_id)))
  with check ((select public.poundwise_is_member(household_id)));

drop policy if exists "poundwise members view transactions" on public.poundwise_transactions;
create policy "poundwise members view transactions"
  on public.poundwise_transactions for select to authenticated
  using ((select public.poundwise_is_member(household_id)));

drop policy if exists "poundwise members create transactions" on public.poundwise_transactions;
create policy "poundwise members create transactions"
  on public.poundwise_transactions for insert to authenticated
  with check ((select public.poundwise_is_member(household_id)));

drop policy if exists "poundwise members update transactions" on public.poundwise_transactions;
create policy "poundwise members update transactions"
  on public.poundwise_transactions for update to authenticated
  using ((select public.poundwise_is_member(household_id)))
  with check ((select public.poundwise_is_member(household_id)));

drop policy if exists "poundwise members delete transactions" on public.poundwise_transactions;
create policy "poundwise members delete transactions"
  on public.poundwise_transactions for delete to authenticated
  using ((select public.poundwise_is_member(household_id)));

create or replace function public.poundwise_keep_newer_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.updated_at < old.updated_at then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists poundwise_settings_newest_wins on public.poundwise_household_settings;
create trigger poundwise_settings_newest_wins
  before update on public.poundwise_household_settings
  for each row execute function public.poundwise_keep_newer_update();

drop trigger if exists poundwise_transactions_newest_wins on public.poundwise_transactions;
create trigger poundwise_transactions_newest_wins
  before update on public.poundwise_transactions
  for each row execute function public.poundwise_keep_newer_update();

create or replace function public.poundwise_create_household(
  p_name text,
  p_display_name text
)
returns table (
  household_id uuid,
  household_name text,
  invite_code text,
  member_role text,
  display_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_household public.poundwise_households;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if char_length(trim(p_name)) not between 1 and 60 then
    raise exception 'Invalid household name';
  end if;
  if char_length(trim(p_display_name)) not between 1 and 30 then
    raise exception 'Invalid display name';
  end if;

  insert into public.poundwise_households (name, owner_id)
  values (trim(p_name), (select auth.uid()))
  returning * into created_household;

  insert into public.poundwise_household_members (household_id, user_id, role, display_name)
  values (created_household.id, (select auth.uid()), 'owner', trim(p_display_name));

  return query
  select created_household.id, created_household.name, created_household.invite_code, 'owner'::text, trim(p_display_name);
end;
$$;

create or replace function public.poundwise_join_household_by_code(
  p_invite_code text,
  p_display_name text
)
returns table (
  household_id uuid,
  household_name text,
  invite_code text,
  member_role text,
  display_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_household public.poundwise_households;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if char_length(trim(p_display_name)) not between 1 and 30 then
    raise exception 'Invalid display name';
  end if;

  select household.* into target_household
  from public.poundwise_households household
  where household.invite_code = upper(trim(p_invite_code));

  if not found then
    raise exception 'Invalid invite code';
  end if;

  insert into public.poundwise_household_members (household_id, user_id, role, display_name)
  values (target_household.id, (select auth.uid()), 'member', trim(p_display_name))
  on conflict (household_id, user_id)
  do update set display_name = excluded.display_name;

  return query
  select target_household.id, target_household.name, target_household.invite_code, member.role, member.display_name
  from public.poundwise_household_members member
  where member.household_id = target_household.id
    and member.user_id = (select auth.uid());
end;
$$;

create or replace function public.poundwise_get_or_create_personal_household(
  p_display_name text
)
returns table (
  household_id uuid,
  household_name text,
  invite_code text,
  member_role text,
  display_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := (select auth.uid());
  created_household public.poundwise_households;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if char_length(trim(p_display_name)) not between 1 and 30 then
    raise exception 'Invalid display name';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  return query
  select household.id, household.name, household.invite_code, member.role, member.display_name
  from public.poundwise_household_members member
  join public.poundwise_households household on household.id = member.household_id
  where member.user_id = current_user_id
  order by member.joined_at asc
  limit 1;

  if found then
    return;
  end if;

  insert into public.poundwise_households (name, owner_id)
  values ('내 가계부', current_user_id)
  returning * into created_household;

  insert into public.poundwise_household_members (household_id, user_id, role, display_name)
  values (created_household.id, current_user_id, 'owner', trim(p_display_name));

  return query
  select created_household.id, created_household.name, created_household.invite_code, 'owner'::text, trim(p_display_name);
end;
$$;

create or replace function public.poundwise_get_my_households()
returns table (
  household_id uuid,
  household_name text,
  invite_code text,
  member_role text,
  display_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select household.id, household.name, household.invite_code, member.role, member.display_name
  from public.poundwise_household_members member
  join public.poundwise_households household on household.id = member.household_id
  where member.user_id = (select auth.uid())
  order by member.joined_at asc;
$$;

create or replace function public.poundwise_rotate_invite_code(p_household_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_code text;
begin
  if not (select public.poundwise_is_owner(p_household_id)) then
    raise exception 'Owner permission required';
  end if;
  new_code := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
  update public.poundwise_households set invite_code = new_code where id = p_household_id;
  return new_code;
end;
$$;

revoke all on function public.poundwise_is_member(uuid) from public;
revoke all on function public.poundwise_is_owner(uuid) from public;
revoke all on function public.poundwise_create_household(text, text) from public;
revoke all on function public.poundwise_join_household_by_code(text, text) from public;
revoke all on function public.poundwise_get_or_create_personal_household(text) from public;
revoke all on function public.poundwise_get_my_households() from public;
revoke all on function public.poundwise_rotate_invite_code(uuid) from public;

grant execute on function public.poundwise_is_member(uuid) to authenticated;
grant execute on function public.poundwise_is_owner(uuid) to authenticated;
grant execute on function public.poundwise_create_household(text, text) to authenticated;
grant execute on function public.poundwise_join_household_by_code(text, text) to authenticated;
grant execute on function public.poundwise_get_or_create_personal_household(text) to authenticated;
grant execute on function public.poundwise_get_my_households() to authenticated;
grant execute on function public.poundwise_rotate_invite_code(uuid) to authenticated;

grant select on public.poundwise_households to authenticated;
grant select on public.poundwise_household_members to authenticated;
grant select, insert, update, delete on public.poundwise_household_settings to authenticated;
grant select, insert, update, delete on public.poundwise_transactions to authenticated;

alter table public.poundwise_transactions replica identity full;
alter table public.poundwise_household_settings replica identity full;
alter table public.poundwise_household_members replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'poundwise_transactions'
    ) then
      alter publication supabase_realtime add table public.poundwise_transactions;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'poundwise_household_settings'
    ) then
      alter publication supabase_realtime add table public.poundwise_household_settings;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'poundwise_household_members'
    ) then
      alter publication supabase_realtime add table public.poundwise_household_members;
    end if;
  end if;
end;
$$;
