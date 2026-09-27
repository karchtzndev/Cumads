-- Limite de volume contra robôs: quem não é da equipe (cliente anônimo ou
-- com conta) só consegue CRIAR um número limitado de documentos por minuto
-- em cada coleção, somando todo mundo. Um uso normal nunca chega perto;
-- um script tentando inundar o sistema de pedidos/mensagens falsos para.
create index if not exists fs_docs_col_created_idx on public.fs_docs (col, created_at);

create or replace function private.fs_throttle(p_col text) returns void
language plpgsql volatile security definer set search_path = public, private as $$
declare
  limite int;
  recentes int;
begin
  limite := case p_col
    when 'orders'    then 30
    when 'customers' then 30
    when 'mensagens' then 10
    when 'clientes'  then 10
    when 'errorLog'  then 30
    when 'visitas'   then 150
    else 60
  end;
  select count(*) into recentes from public.fs_docs
   where col = p_col and created_at > now() - interval '1 minute';
  if recentes >= limite then
    raise exception 'resource-exhausted' using errcode = '54000';
  end if;
end $$;
revoke execute on function private.fs_throttle(text) from public, anon, authenticated;

create or replace function public.fs_commit(p_writes jsonb, p_pre jsonb default '[]'::jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public, private as $$
declare
  w jsonb;
  pre jsonb;
  cur public.fs_docs;
  v_col text;
  v_id text;
  v_op text;
  newdata jsonb;
  kind text;
  existe boolean;
  equipe boolean := private.fs_is_staff();
  n int := 0;
begin
  if jsonb_typeof(p_writes) <> 'array' or jsonb_array_length(p_writes) > 500 then
    raise exception 'invalid-argument' using errcode = '22023';
  end if;
  -- fora da equipe, lotes grandes não fazem sentido
  if not equipe and jsonb_array_length(p_writes) > 10 then
    raise exception 'invalid-argument' using errcode = '22023';
  end if;

  for pre in select * from jsonb_array_elements(coalesce(p_pre, '[]'::jsonb)) loop
    select * into cur from public.fs_docs
     where col = pre->>'col' and id = pre->>'id' for update;
    if (case when found then cur.version else null end) is distinct from (pre->>'version')::bigint then
      raise exception 'aborted' using errcode = '40001';
    end if;
  end loop;

  for w in select * from jsonb_array_elements(p_writes) loop
    v_col := w->>'col';
    v_id  := w->>'id';
    v_op  := w->>'op';
    if v_col is null or v_id is null or v_id = '' or length(v_id) > 200 then
      raise exception 'invalid-argument' using errcode = '22023';
    end if;

    select * into cur from public.fs_docs where col = v_col and id = v_id for update;
    existe := found;

    if v_op = 'delete' then
      if not private.fs_can_write(v_col, v_id, 'delete', case when existe then cur.data end, null) then
        raise exception 'permission-denied' using errcode = '42501';
      end if;
      delete from public.fs_docs where col = v_col and id = v_id;
    else
      if v_op = 'update' then
        if not existe then
          raise exception 'not-found' using errcode = 'P0002';
        end if;
        newdata := fs_update(cur.data, w->'data');
      elsif coalesce((w->>'merge')::boolean, false) then
        newdata := fs_merge(case when existe then cur.data end, w->'data');
      else
        newdata := fs_merge('{}'::jsonb, w->'data');
      end if;

      if octet_length(newdata::text) > 1000000 then
        raise exception 'invalid-argument' using errcode = '22023';
      end if;
      -- documento de cliente não precisa passar de 50 KB
      if not equipe and octet_length(newdata::text) > 50000 then
        raise exception 'invalid-argument' using errcode = '22023';
      end if;

      kind := case when existe then 'update' else 'create' end;
      if not private.fs_can_write(v_col, v_id, kind, case when existe then cur.data end, newdata) then
        raise exception 'permission-denied' using errcode = '42501';
      end if;

      if existe then
        update public.fs_docs
           set data = newdata, version = cur.version + 1, updated_at = now()
         where col = v_col and id = v_id;
      else
        if not equipe then
          perform private.fs_throttle(v_col);
        end if;
        insert into public.fs_docs (col, id, data) values (v_col, v_id, newdata);
      end if;
    end if;
    n := n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'writes', n);
end $$;

revoke all on function public.fs_commit(jsonb, jsonb) from public;
grant execute on function public.fs_commit(jsonb, jsonb) to anon, authenticated;

-- usado pela edge function criar-conta para barrar criação em massa
create or replace function public.fs_contas_recentes() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from auth.users where created_at > now() - interval '10 minutes'
$$;
revoke all on function public.fs_contas_recentes() from public, anon, authenticated;
grant execute on function public.fs_contas_recentes() to service_role;
