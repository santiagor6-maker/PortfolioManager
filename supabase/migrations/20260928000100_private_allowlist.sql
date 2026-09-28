-- Keep the allowlist and its check out of the exposed API schema, and let the two RPCs run with the
-- caller's rights under RLS instead of as SECURITY DEFINER.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter table public.allowed_emails set schema private;

drop policy "Allowed users read their own dataset" on public.datasets;
drop function public.dataset_version();
drop function public.save_dataset(integer, text, text, jsonb, text);
drop function public.is_allowed();

create function private.is_allowed() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.allowed_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;
revoke execute on function private.is_allowed() from public, anon;
grant execute on function private.is_allowed() to authenticated;

grant select, insert, update on public.datasets to authenticated;

create policy "Allowed users read their own dataset" on public.datasets
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()));
create policy "Allowed users create their own dataset" on public.datasets
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.is_allowed()));
create policy "Allowed users update their own dataset" on public.datasets
  for update to authenticated
  using (user_id = (select auth.uid()) and (select private.is_allowed()))
  with check (user_id = (select auth.uid()) and (select private.is_allowed()));

-- The stored version (0 when there is none yet), without downloading the blob.
create function public.dataset_version() returns integer
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_allowed() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((select d.version from public.datasets d where d.user_id = auth.uid()), 0);
end
$$;
revoke execute on function public.dataset_version() from public, anon;
grant execute on function public.dataset_version() to authenticated;

-- Optimistic save: writes only when the stored version is `expected` (0 = no row yet) and returns the
-- new version, or -1 when another device saved first. Never merges.
create function public.save_dataset(expected integer, p_blob text, p_salt text, p_kdf jsonb, p_device text)
returns integer
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v integer;
begin
  if uid is null or not private.is_allowed() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(p_blob) > 25000000 then
    raise exception 'dataset too large' using errcode = '22001';
  end if;
  if expected = 0 then
    insert into public.datasets (user_id, blob, salt, kdf, version, device)
    values (uid, p_blob, p_salt, p_kdf, 1, p_device)
    on conflict (user_id) do nothing;
    if found then
      return 1;
    end if;
    return -1;
  end if;
  update public.datasets d
     set blob = p_blob, salt = p_salt, kdf = p_kdf, version = d.version + 1, device = p_device, updated_at = now()
   where d.user_id = uid and d.version = expected
  returning d.version into v;
  return coalesce(v, -1);
end
$$;
revoke execute on function public.save_dataset(integer, text, text, jsonb, text) from public, anon;
grant execute on function public.save_dataset(integer, text, text, jsonb, text) to authenticated;
