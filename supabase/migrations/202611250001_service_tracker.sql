create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references auth.users(id) on delete cascade,
  registration text not null check (length(trim(registration)) > 0),
  make text not null default '',
  model text not null default '',
  created_at timestamptz not null default now(),
  constraint vehicles_id_advisor_unique unique (id, advisor_id)
);

create unique index vehicles_advisor_registration_unique
  on public.vehicles (advisor_id, upper(registration));

create table public.service_jobs (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null,
  job_ref text not null,
  owner_name text not null check (length(trim(owner_name)) > 0),
  whatsapp_number text not null check (length(trim(whatsapp_number)) > 0),
  odometer bigint not null check (odometer >= 0),
  requested_work text not null check (length(trim(requested_work)) > 0),
  promised_pickup_at timestamptz,
  service_notes text not null default '',
  status text not null default 'checked_in'
    check (status in ('checked_in', 'in_service', 'on_hold', 'ready')),
  status_reason text,
  created_at timestamptz not null default now(),
  constraint service_jobs_vehicle_advisor_fk
    foreign key (vehicle_id, advisor_id) references public.vehicles(id, advisor_id),
  constraint service_jobs_advisor_ref_unique unique (advisor_id, job_ref)
);

create index service_jobs_advisor_created_idx
  on public.service_jobs (advisor_id, created_at desc);
create index service_jobs_vehicle_status_idx
  on public.service_jobs (vehicle_id, status);

create table public.status_history (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.service_jobs(id) on delete cascade,
  advisor_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('checked_in', 'in_service', 'on_hold', 'ready')),
  reason text,
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now()
);

create index status_history_job_changed_idx on public.status_history (job_id, changed_at desc);

create or replace function public.validate_service_job_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'checked_in' then
      raise exception 'New service jobs must start as checked in';
    end if;
    new.status_reason := null;
    return new;
  end if;

  if new.id <> old.id or new.advisor_id <> old.advisor_id or new.vehicle_id <> old.vehicle_id then
    raise exception 'A service job cannot be reassigned to another advisor or vehicle';
  end if;

  if new.status = old.status then
    return new;
  end if;

  if not (
    (old.status = 'checked_in' and new.status in ('in_service', 'on_hold'))
    or (old.status = 'in_service' and new.status in ('on_hold', 'ready'))
    or (old.status = 'on_hold' and new.status in ('in_service', 'ready'))
    or (old.status = 'ready' and new.status = 'in_service')
  ) then
    raise exception 'Invalid service job status transition';
  end if;

  if new.status = 'on_hold' and length(trim(coalesce(new.status_reason, ''))) = 0 then
    raise exception 'A reason is required when putting a job on hold';
  end if;

  if old.status = 'ready' and new.status = 'in_service'
    and length(trim(coalesce(new.status_reason, ''))) = 0 then
    raise exception 'A reason is required when returning a ready job to service';
  end if;

  if new.status = 'ready' and old.status <> 'ready' then
    new.status_reason := null;
  end if;

  return new;
end;
$$;

create trigger service_jobs_validate_transition
before insert or update on public.service_jobs
for each row execute function public.validate_service_job_transition();

create or replace function public.record_service_job_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.status_history (job_id, advisor_id, status, reason, changed_by)
    values (
      new.id,
      new.advisor_id,
      new.status,
      case when new.status in ('on_hold', 'in_service') then new.status_reason else null end,
      auth.uid()
    );
  end if;
  return new;
end;
$$;

create trigger service_jobs_record_status
after insert or update of status on public.service_jobs
for each row execute function public.record_service_job_status();

alter table public.vehicles enable row level security;
alter table public.service_jobs enable row level security;
alter table public.status_history enable row level security;

create policy "Advisors can read their vehicles"
  on public.vehicles for select to authenticated
  using (advisor_id = (select auth.uid()));
create policy "Advisors can create their vehicles"
  on public.vehicles for insert to authenticated
  with check (advisor_id = (select auth.uid()));
create policy "Advisors can update their vehicles"
  on public.vehicles for update to authenticated
  using (advisor_id = (select auth.uid()))
  with check (advisor_id = (select auth.uid()));

create policy "Advisors can read their service jobs"
  on public.service_jobs for select to authenticated
  using (advisor_id = (select auth.uid()));
create policy "Advisors can create their service jobs"
  on public.service_jobs for insert to authenticated
  with check (
    advisor_id = (select auth.uid())
    and exists (
      select 1 from public.vehicles
      where vehicles.id = service_jobs.vehicle_id
        and vehicles.advisor_id = (select auth.uid())
    )
  );
create policy "Advisors can update their service jobs"
  on public.service_jobs for update to authenticated
  using (advisor_id = (select auth.uid()))
  with check (advisor_id = (select auth.uid()));

create policy "Advisors can read their status history"
  on public.status_history for select to authenticated
  using (advisor_id = (select auth.uid()));

grant select, insert, update on public.vehicles to authenticated;
grant select, insert, update on public.service_jobs to authenticated;
grant select on public.status_history to authenticated;
revoke all on public.vehicles, public.service_jobs, public.status_history from anon;
