alter table public.service_jobs
  drop constraint service_jobs_status_check,
  add constraint service_jobs_status_check
    check (status in ('checked_in', 'in_service', 'on_hold', 'ready', 'handed_over'));

alter table public.status_history
  drop constraint status_history_status_check,
  add constraint status_history_status_check
    check (status in ('checked_in', 'in_service', 'on_hold', 'ready', 'handed_over'));

alter table public.service_jobs
  add constraint service_jobs_id_advisor_unique unique (id, advisor_id);

create table public.service_handovers (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique,
  advisor_id uuid not null references auth.users(id) on delete cascade,
  signer_name text not null check (length(trim(signer_name)) > 0),
  signer_relationship text not null
    check (signer_relationship in ('owner', 'authorized_pickup')),
  signed_at timestamptz not null default now(),
  signature_path text not null,
  pdf_path text not null,
  constraint service_handovers_job_advisor_fk
    foreign key (job_id, advisor_id)
    references public.service_jobs(id, advisor_id) on delete cascade
);

alter table public.service_handovers enable row level security;

create policy "Advisors can read their service handovers"
  on public.service_handovers for select to authenticated
  using (advisor_id = (select auth.uid()));

revoke all on public.service_handovers from anon, authenticated;
grant select on public.service_handovers to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'service-handovers',
  'service-handovers',
  false,
  10485760,
  array['image/png', 'application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Advisors can upload handover files for their jobs"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'service-handovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.service_jobs
      where service_jobs.id::text = (storage.foldername(name))[2]
        and service_jobs.advisor_id = (select auth.uid())
    )
  );

create policy "Advisors can read handover files for their jobs"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'service-handovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.service_jobs
      where service_jobs.id::text = (storage.foldername(name))[2]
        and service_jobs.advisor_id = (select auth.uid())
    )
  );

create policy "Advisors can remove uncommitted handover files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'service-handovers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1
      from public.service_jobs
      where service_jobs.id::text = (storage.foldername(name))[2]
        and service_jobs.advisor_id = (select auth.uid())
    )
    and not exists (
      select 1
      from public.service_handovers
      where service_handovers.signature_path = storage.objects.name
        or service_handovers.pdf_path = storage.objects.name
    )
  );

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

  if old.status = 'handed_over' then
    raise exception 'A handed-over service job is read-only';
  end if;

  if new.status = old.status then
    return new;
  end if;

  if not (
    (old.status = 'checked_in' and new.status in ('in_service', 'on_hold'))
    or (old.status = 'in_service' and new.status in ('on_hold', 'ready'))
    or (old.status = 'on_hold' and new.status in ('in_service', 'ready'))
    or (old.status = 'ready' and new.status = 'in_service')
    or (
      old.status = 'ready'
      and new.status = 'handed_over'
      and exists (
        select 1
        from public.service_handovers
        where service_handovers.job_id = old.id
          and service_handovers.advisor_id = old.advisor_id
      )
    )
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

  if new.status in ('ready', 'handed_over') and old.status <> new.status then
    new.status_reason := null;
  end if;

  return new;
end;
$$;

create or replace function public.complete_service_job_handover(
  p_job_id uuid,
  p_signer_name text,
  p_signer_relationship text,
  p_signature_path text,
  p_pdf_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_advisor_id uuid := auth.uid();
  v_job_status text;
  v_handover_id uuid;
  v_signature_folders text[];
  v_pdf_folders text[];
begin
  if v_advisor_id is null then
    raise exception 'Authentication is required to complete a handover';
  end if;
  if length(trim(coalesce(p_signer_name, ''))) = 0 then
    raise exception 'The pickup person name is required';
  end if;
  if p_signer_relationship is null
    or p_signer_relationship not in ('owner', 'authorized_pickup') then
    raise exception 'Select whether the signer is the owner or an authorized pickup person';
  end if;

  v_signature_folders := storage.foldername(p_signature_path);
  v_pdf_folders := storage.foldername(p_pdf_path);
  if p_signature_path is null
    or p_pdf_path is null
    or v_signature_folders[1] <> v_advisor_id::text
    or v_pdf_folders[1] <> v_advisor_id::text
    or v_signature_folders[2] <> p_job_id::text
    or v_pdf_folders[2] <> p_job_id::text
    or v_signature_folders[3] is null
    or v_pdf_folders[3] is null
    or v_signature_folders[3] <> v_pdf_folders[3]
    or storage.filename(p_signature_path) <> 'signature.png'
    or storage.filename(p_pdf_path) <> 'handover.pdf' then
    raise exception 'Handover files must be stored under this advisor and job';
  end if;
  if not exists (
    select 1 from storage.objects
    where storage.objects.bucket_id = 'service-handovers'
      and storage.objects.name = p_signature_path
  ) or not exists (
    select 1 from storage.objects
    where storage.objects.bucket_id = 'service-handovers'
      and storage.objects.name = p_pdf_path
  ) then
    raise exception 'Upload the signed receipt and PDF before completing the handover';
  end if;

  select service_jobs.status
    into v_job_status
    from public.service_jobs
    where service_jobs.id = p_job_id
      and service_jobs.advisor_id = v_advisor_id
    for update;
  if not found then
    raise exception 'Service job not found';
  end if;
  if v_job_status <> 'ready' then
    raise exception 'Only a job ready for pickup can be handed over';
  end if;

  insert into public.service_handovers (
    job_id,
    advisor_id,
    signer_name,
    signer_relationship,
    signature_path,
    pdf_path
  ) values (
    p_job_id,
    v_advisor_id,
    trim(p_signer_name),
    p_signer_relationship,
    p_signature_path,
    p_pdf_path
  )
  returning id into v_handover_id;

  update public.service_jobs
    set status = 'handed_over',
        status_reason = null
    where id = p_job_id
      and advisor_id = v_advisor_id;

  return v_handover_id;
end;
$$;

revoke all on function public.complete_service_job_handover(uuid, text, text, text, text) from public, anon;
grant execute on function public.complete_service_job_handover(uuid, text, text, text, text) to authenticated;

grant usage on schema public to authenticated;
