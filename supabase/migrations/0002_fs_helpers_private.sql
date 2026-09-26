-- Tira as funções auxiliares de regra da API pública (schema "private"
-- não é exposto pelo PostgREST). Só fs_get/fs_commit ficam públicas —
-- elas são a API do app e aplicam as regras antes de ler/gravar.
create schema if not exists private;
grant usage on schema private to anon, authenticated;

alter function public.fs_profile() set schema private;
alter function public.fs_is_staff() set schema private;
alter function public.fs_is_manager() set schema private;
alter function public.fs_has_perm(text) set schema private;
alter function public.fs_can_read(text, text, boolean) set schema private;
alter function public.fs_can_write(text, text, text, jsonb, jsonb) set schema private;

alter function private.fs_profile() set search_path = public, private;
alter function private.fs_is_staff() set search_path = public, private;
alter function private.fs_is_manager() set search_path = public, private;
alter function private.fs_has_perm(text) set search_path = public, private;
alter function private.fs_can_read(text, text, boolean) set search_path = public, private;
alter function private.fs_can_write(text, text, text, jsonb, jsonb) set search_path = public, private;
alter function public.fs_get(text, text) set search_path = public, private;
alter function public.fs_commit(jsonb, jsonb) set search_path = public, private;

create or replace function private.fs_is_staff() returns boolean
language sql stable security definer set search_path = public, private as $$
  select auth.uid() is not null
     and coalesce((private.fs_profile() -> 'active') = 'true'::jsonb, false)
$$;
create or replace function private.fs_is_manager() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.fs_is_staff()
     and coalesce(private.fs_profile() ->> 'role' = 'gerente', false)
$$;
create or replace function private.fs_has_perm(area text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.fs_is_staff() and (
    coalesce(private.fs_profile() ->> 'role' = 'gerente', false)
    or coalesce(jsonb_typeof(private.fs_profile() -> 'perms') = 'array'
                and (private.fs_profile() -> 'perms') ? area, false)
  )
$$;

revoke execute on all functions in schema private from public;
grant execute on function private.fs_can_read(text, text, boolean) to anon, authenticated;
