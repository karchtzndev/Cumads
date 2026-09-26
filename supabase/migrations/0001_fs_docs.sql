-- =====================================================================
-- Cumad's Grill — banco de dados (Supabase / Postgres)
--
-- O app foi escrito em cima da API de documentos do Firestore
-- (coleção → documento → JSON). Em vez de reescrever as ~14 mil linhas
-- do front, guardamos cada documento como uma linha JSONB aqui e o
-- arquivo /supa-firebase.js imita a API do Firestore por cima disso.
--
-- Segurança: regras de acesso por coleção (quem lê/grava o quê), escritas como
-- funções Postgres. Leitura passa pelo RLS; escrita SÓ pela função
-- fs_commit (security definer), que aplica as regras antes de gravar.
-- =====================================================================

create table if not exists public.fs_docs (
  col        text   not null,
  id         text   not null,
  data       jsonb  not null default '{}'::jsonb,
  version    bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  key        text generated always as (col || '/' || id) stored,
  primary key (col, id)
);

create index if not exists fs_docs_key_idx on public.fs_docs (key);
create index if not exists fs_docs_orders_created_idx on public.fs_docs ((data->'createdAt')) where col = 'orders';

alter table public.fs_docs enable row level security;
alter table public.fs_docs replica identity full;

-- ---------------------------------------------------------------------
-- Helpers de JSON
-- ---------------------------------------------------------------------
create or replace function public.fs_jsize(v jsonb) returns int
language sql immutable set search_path = public as $$
  select case jsonb_typeof(v)
    when 'string' then char_length(v #>> '{}')
    when 'array'  then jsonb_array_length(v)
    when 'object' then (select count(*)::int from jsonb_object_keys(v))
    else null end
$$;

create or replace function public.fs_num(v jsonb) returns numeric
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric else null end
$$;

create or replace function public.fs_is_num(v jsonb) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(jsonb_typeof(v) = 'number', false)
$$;

-- keys().hasOnly([...])
create or replace function public.fs_keys_only(d jsonb, allowed text[]) returns boolean
language sql immutable set search_path = public as $$
  select d is not null and jsonb_typeof(d) = 'object'
     and not exists (select 1 from jsonb_object_keys(d) k where k <> all(allowed))
$$;

-- diff(resource.data).affectedKeys().hasOnly([...])
create or replace function public.fs_changed_only(o jsonb, n jsonb, allowed text[]) returns boolean
language sql immutable set search_path = public as $$
  select not exists (
    select 1 from (
      select jsonb_object_keys(coalesce(o, '{}'::jsonb)) k
      union
      select jsonb_object_keys(coalesce(n, '{}'::jsonb))
    ) s
    where (o -> s.k) is distinct from (n -> s.k)
      and s.k <> all(allowed)
  )
$$;

-- ---------------------------------------------------------------------
-- Quem é o usuário (perfil da equipe em users/{uid})
-- ---------------------------------------------------------------------
create or replace function public.fs_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select d.data from public.fs_docs d
   where d.col = 'users' and d.id = auth.uid()::text
$$;

create or replace function public.fs_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and coalesce((public.fs_profile() -> 'active') = 'true'::jsonb, false)
$$;

create or replace function public.fs_is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select public.fs_is_staff()
     and coalesce(public.fs_profile() ->> 'role' = 'gerente', false)
$$;

create or replace function public.fs_has_perm(area text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.fs_is_staff() and (
    coalesce(public.fs_profile() ->> 'role' = 'gerente', false)
    or coalesce(jsonb_typeof(public.fs_profile() -> 'perms') = 'array'
                and (public.fs_profile() -> 'perms') ? area, false)
  )
$$;

-- ---------------------------------------------------------------------
-- REGRAS DE LEITURA  (p_get = leitura de 1 documento pelo id;
--                     senão é listagem/consulta)
-- ---------------------------------------------------------------------
create or replace function public.fs_can_read(p_col text, p_id text, p_get boolean)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  logado boolean := auth.uid() is not null;
begin
  case p_col
    when 'users' then
      if p_get then return logado and (auth.uid()::text = p_id or fs_is_manager()); end if;
      return fs_is_manager() or (logado and auth.uid()::text = p_id);
    when 'store' then
      case p_id
        when 'menu', 'promo', 'info', 'tempoPreparo', 'features' then return true;
        when 'backupInfo', 'inventory', 'register', 'printer' then return fs_is_staff();
        when 'cashflow', 'fixedcosts' then return fs_has_perm('financeiro');
        else return false;
      end case;
    when 'orders' then
      return p_get or fs_is_staff();
    when 'stats' then
      return fs_has_perm('dashboard') or fs_has_perm('financeiro');
    when 'closings' then
      return fs_has_perm('financeiro');
    when 'visitas', 'acessos', 'mensagens', 'errorLog', 'customers', 'printQueue' then
      return fs_is_staff();
    when 'cupons' then
      return p_get or fs_is_staff();
    when 'clientes' then
      if p_get then return logado and (auth.uid()::text = p_id or fs_is_staff()); end if;
      return fs_is_staff() or (logado and auth.uid()::text = p_id);
    when 'calls', 'counters' then
      return true;
    else
      return false;
  end case;
end $$;

drop policy if exists fs_docs_select on public.fs_docs;
create policy fs_docs_select on public.fs_docs
  for select to anon, authenticated
  using (public.fs_can_read(col, id, false));

revoke all on public.fs_docs from anon, authenticated;
grant select on public.fs_docs to anon, authenticated;

-- ---------------------------------------------------------------------
-- REGRAS DE ESCRITA  (uma regra por coleção)
--   p_op: 'create' | 'update' | 'delete'
--   o = documento atual (resource.data), n = como vai ficar (request.resource.data)
-- ---------------------------------------------------------------------
create or replace function public.fs_can_write(p_col text, p_id text, p_op text, o jsonb, n jsonb)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  logado boolean := auth.uid() is not null;
  uid text := auth.uid()::text;
begin
  case p_col

  -- ---------- CONTAS DA EQUIPE ----------
  when 'users' then
    return fs_is_manager();

  -- ---------- DADOS DA LOJA ----------
  when 'store' then
    case p_id
      when 'menu'       then return fs_has_perm('cardapio');
      when 'promo'      then return fs_has_perm('promocao');
      when 'info'       then return fs_has_perm('loja');
      when 'tempoPreparo' then
        return p_op <> 'delete' and fs_is_staff()
           and fs_keys_only(n, array['amostras','atualizadoEm']);
      when 'backupInfo' then return fs_is_staff();
      when 'features'   then return fs_is_manager();
      when 'inventory'  then return fs_has_perm('estoque');
      when 'register'   then return fs_has_perm('caixa');
      when 'cashflow'   then return fs_is_staff();
      when 'fixedcosts' then return fs_has_perm('financeiro');
      when 'printer'    then return fs_is_staff();
      else return false;
    end case;

  -- ---------- PEDIDOS ----------
  when 'orders' then
    if p_op = 'create' then
      return fs_is_staff() or coalesce((
            fs_is_num(n->'total')
        and fs_num(n->'total') between 0 and 5000
        and n->>'status' = 'recebido'
        and not (n ? 'paid')
        and (not (n ? 'items') or (jsonb_typeof(n->'items') = 'array' and fs_jsize(n->'items') <= 40))
        and (not (n ? 'notes') or fs_jsize(n->'notes') <= 500)
        and (not (n ? 'desconto') or (fs_is_num(n->'desconto') and fs_num(n->'desconto') between 0 and 500))
      ), false);
    elsif p_op = 'update' then
      return fs_is_staff()
          or fs_changed_only(o, n, array['rating','ratingComment','ratingItens','ratedAt']);
    else
      return fs_is_staff();
    end if;

  -- ---------- ESTATÍSTICAS DIÁRIAS ----------
  when 'stats' then
    if p_op = 'create' then
      return coalesce((
            fs_keys_only(n, array['date','orderCount','revenue','byType','products','canceled'])
        and n->>'date' = p_id
        and fs_is_num(n->'orderCount') and fs_num(n->'orderCount') between 0 and 50
        and fs_is_num(n->'revenue') and fs_num(n->'revenue') between 0 and 5000
      ), false);
    elsif p_op = 'update' then
      return fs_is_staff() or coalesce((
            fs_changed_only(o, n, array['orderCount','revenue','byType','products','date'])
        and fs_num(n->'orderCount') <= fs_num(o->'orderCount') + 50
        and fs_num(n->'revenue') <= fs_num(o->'revenue') + 5000
      ), false);
    else
      return fs_is_manager();
    end if;

  -- ---------- FECHAMENTOS DE CAIXA ----------
  when 'closings' then
    if p_op = 'create' then return fs_is_staff(); end if;
    return fs_is_manager();

  -- ---------- VISITAS AO SITE ----------
  when 'visitas' then
    if p_op = 'create' then
      return coalesce((
            fs_keys_only(n, array['entrada','ultimaAtividade','aparelho','origem','finalizou',
                                  'codigoPedido','novaVisitaAposVoltar','expiraEm'])
        and n->'finalizou' = 'false'::jsonb
        and fs_jsize(n->'aparelho') <= 30
        and fs_jsize(n->'origem') <= 100
      ), false);
    elsif p_op = 'update' then
      return coalesce((
            fs_changed_only(o, n, array['ultimaAtividade','finalizou','codigoPedido','finalizadoEm',
                                        'telefoneDigitado','carrinhoNoAbandono','valorCarrinho'])
        and (o->'finalizou' = 'false'::jsonb or n->'finalizou' = 'true'::jsonb)
        and (not (n ? 'telefoneDigitado') or fs_jsize(n->'telefoneDigitado') <= 20)
        and (not (n ? 'carrinhoNoAbandono') or fs_jsize(n->'carrinhoNoAbandono') <= 40)
        and (not (n ? 'valorCarrinho') or (fs_is_num(n->'valorCarrinho') and fs_num(n->'valorCarrinho') <= 5000))
      ), false);
    else
      return fs_is_manager();
    end if;

  -- ---------- REGISTRO DE ACESSOS ----------
  when 'acessos' then
    if p_op = 'create' then
      return fs_is_staff() and coalesce((
            n->>'uid' = uid
        and fs_keys_only(n, array['uid','nome','funcao','entrada','ultimoSinal','saida',
                                  'aparelho','tela','expiraEm'])
      ), false);
    elsif p_op = 'update' then
      return fs_is_staff() and coalesce((
            o->>'uid' = uid
        and fs_changed_only(o, n, array['ultimoSinal','saida'])
      ), false);
    else
      return fs_is_manager();
    end if;

  -- ---------- MENSAGENS DOS CLIENTES ----------
  when 'mensagens' then
    if p_op = 'create' then
      return coalesce((
            fs_keys_only(n, array['tipo','mensagem','nome','telefone','lida','quando'])
        and jsonb_typeof(n->'mensagem') = 'string'
        and fs_jsize(n->'mensagem') between 5 and 600
        and n->'lida' = 'false'::jsonb
      ), false);
    end if;
    return fs_is_staff();

  -- ---------- CUPONS ----------
  when 'cupons' then
    if p_op in ('create', 'delete') then
      return fs_has_perm('cupons') or fs_is_manager();
    end if;
    return fs_has_perm('cupons') or fs_is_manager() or coalesce((
          fs_changed_only(o, n, array['usos','totalDescontado','ultimoUso'])
      and fs_num(n->'usos') = coalesce(fs_num(o->'usos'), 0) + 1
      and coalesce(fs_num(n->'totalDescontado'), 0) >= coalesce(fs_num(o->'totalDescontado'), 0)
      and coalesce(fs_num(n->'totalDescontado'), 0) <= coalesce(fs_num(o->'totalDescontado'), 0) + 500
    ), false);

  -- ---------- CONTA OPCIONAL DO CLIENTE ----------
  when 'clientes' then
    if p_op = 'create' then
      return logado and uid = p_id
         and fs_keys_only(n, array['nome','email','telefone','criadoEm']);
    elsif p_op = 'update' then
      return logado and uid = p_id and fs_changed_only(o, n, array['nome','telefone']);
    else
      return (logado and uid = p_id) or fs_is_manager();
    end if;

  -- ---------- CADASTRO DE CLIENTES (fidelidade) ----------
  when 'customers' then
    if p_op = 'create' then
      return coalesce((
            fs_keys_only(n, array['nome','telefone','endereco','pedidos','gasto','ultimo','atualizadoEm'])
        and fs_num(n->'pedidos') = 1
      ), false);
    elsif p_op = 'update' then
      return fs_is_staff() or coalesce((
            fs_changed_only(o, n, array['nome','telefone','endereco','pedidos','gasto','ultimo','atualizadoEm'])
        and fs_num(n->'pedidos') = coalesce(fs_num(o->'pedidos'), 0) + 1
        and coalesce(fs_num(n->'gasto'), 0) <= coalesce(fs_num(o->'gasto'), 0) + 5000
      ), false);
    else
      return fs_is_manager();
    end if;

  -- ---------- FILA DE IMPRESSÃO ----------
  when 'printQueue' then
    return fs_is_staff();

  -- ---------- REGISTRO DE ERROS ----------
  when 'errorLog' then
    if p_op = 'create' then
      return coalesce((
            fs_keys_only(n, array['mensagem','detalhe','pagina','url','navegador','plataforma',
                                  'toque','modoComputador','tela','online','usuario','funcao',
                                  'quando','expiraEm'])
        and jsonb_typeof(n->'mensagem') = 'string'
        and fs_jsize(n->'mensagem') <= 500
      ), false);
    elsif p_op = 'update' then
      return false;
    else
      return fs_is_manager();
    end if;

  -- ---------- CHAMADAS NA TV ----------
  when 'calls' then
    if p_op = 'create' then return fs_is_staff(); end if;
    return fs_is_manager();

  -- ---------- CONTADOR DIÁRIO ----------
  when 'counters' then
    if p_op = 'create' then
      return fs_is_manager() or coalesce((
        fs_keys_only(n, array['date','count']) and fs_num(n->'count') = 1
      ), false);
    elsif p_op = 'update' then
      return fs_is_manager() or coalesce((
            fs_keys_only(n, array['date','count'])
        and fs_is_num(n->'count') and fs_num(n->'count') = trunc(fs_num(n->'count'))
        and (
              fs_num(n->'count') = fs_num(o->'count') + 1
           or (n->>'date' is distinct from o->>'date' and fs_num(n->'count') = 1)
        )
      ), false);
    else
      return false;
    end if;

  else
    return false;
  end case;
end $$;

-- ---------------------------------------------------------------------
-- Transformações de campo (FieldValue.increment / arrayUnion / ...)
-- O cliente manda {"__fv":"increment","n":1} etc. e o servidor resolve
-- de forma atômica, igual ao Firestore.
-- ---------------------------------------------------------------------
create or replace function public.fs_is_sentinel(v jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(v) = 'object' and v ? '__fv'
$$;

create or replace function public.fs_now_iso() returns jsonb
language sql stable set search_path = public as $$
  select to_jsonb(to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

create or replace function public.fs_transform(cur jsonb, s jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  base jsonb;
  e jsonb;
begin
  case s->>'__fv'
    when 'increment' then
      if fs_is_num(cur) then
        return to_jsonb(fs_num(cur) + fs_num(s->'n'));
      end if;
      return s->'n';
    when 'arrayUnion' then
      base := case when jsonb_typeof(cur) = 'array' then cur else '[]'::jsonb end;
      for e in select * from jsonb_array_elements(coalesce(s->'v', '[]'::jsonb)) loop
        if not exists (select 1 from jsonb_array_elements(base) x where x = e) then
          base := base || jsonb_build_array(e);
        end if;
      end loop;
      return base;
    when 'arrayRemove' then
      base := case when jsonb_typeof(cur) = 'array' then cur else '[]'::jsonb end;
      return coalesce((
        select jsonb_agg(x) from jsonb_array_elements(base) x
         where not exists (select 1 from jsonb_array_elements(coalesce(s->'v','[]'::jsonb)) r where r = x)
      ), '[]'::jsonb);
    when 'serverTimestamp' then
      return fs_now_iso();
    else
      return null;
  end case;
end $$;

-- set(..., {merge:true}): mescla mapas recursivamente
create or replace function public.fs_merge(old jsonb, patch jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  result jsonb := case when jsonb_typeof(old) = 'object' then old else '{}'::jsonb end;
  k text;
  v jsonb;
begin
  for k, v in select * from jsonb_each(coalesce(patch, '{}'::jsonb)) loop
    if fs_is_sentinel(v) then
      if v->>'__fv' = 'delete' then
        result := result - k;
      else
        result := result || jsonb_build_object(k, fs_transform(result->k, v));
      end if;
    elsif jsonb_typeof(v) = 'object' then
      result := result || jsonb_build_object(k, fs_merge(result->k, v));
    else
      result := result || jsonb_build_object(k, v);
    end if;
  end loop;
  return result;
end $$;

-- grava valor num caminho a.b.c criando os mapas intermediários
create or replace function public.fs_set_path(doc jsonb, path text[], val jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  base jsonb := case when jsonb_typeof(doc) = 'object' then doc else '{}'::jsonb end;
begin
  if array_length(path, 1) = 1 then
    return base || jsonb_build_object(path[1], val);
  end if;
  return base || jsonb_build_object(path[1], fs_set_path(base->path[1], path[2:], val));
end $$;

-- update(): chaves com ponto viram caminho; mapas são substituídos
create or replace function public.fs_update(old jsonb, patch jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  result jsonb := old;
  k text;
  v jsonb;
  p text[];
begin
  for k, v in select * from jsonb_each(coalesce(patch, '{}'::jsonb)) loop
    p := string_to_array(k, '.');
    if fs_is_sentinel(v) then
      if v->>'__fv' = 'delete' then
        result := result #- p;
      else
        result := fs_set_path(result, p, fs_transform(result #> p, v));
      end if;
    else
      -- resolve sentinelas aninhadas (ex.: {byType:{x: increment}})
      if jsonb_typeof(v) = 'object' then v := fs_merge('{}'::jsonb, v); end if;
      result := fs_set_path(result, p, v);
    end if;
  end loop;
  return result;
end $$;

-- ---------------------------------------------------------------------
-- Leitura de 1 documento (aplica a regra "get")
-- ---------------------------------------------------------------------
create or replace function public.fs_get(p_col text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r public.fs_docs;
begin
  if not fs_can_read(p_col, p_id, true) then
    raise exception 'permission-denied' using errcode = '42501';
  end if;
  select * into r from public.fs_docs where col = p_col and id = p_id;
  if not found then
    return jsonb_build_object('exists', false, 'data', null, 'version', null);
  end if;
  return jsonb_build_object('exists', true, 'data', r.data, 'version', r.version);
end $$;

-- ---------------------------------------------------------------------
-- Escrita: lote atômico de set/update/delete, com pré-condições de versão
-- (usado por runTransaction, batch e escritas simples)
-- ---------------------------------------------------------------------
create or replace function public.fs_commit(p_writes jsonb, p_pre jsonb default '[]'::jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
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
  n int := 0;
begin
  if jsonb_typeof(p_writes) <> 'array' or jsonb_array_length(p_writes) > 500 then
    raise exception 'invalid-argument' using errcode = '22023';
  end if;

  -- pré-condições (transações): versão lida precisa ser a mesma de agora
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
      if not fs_can_write(v_col, v_id, 'delete', case when existe then cur.data end, null) then
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

      kind := case when existe then 'update' else 'create' end;
      if not fs_can_write(v_col, v_id, kind, case when existe then cur.data end, newdata) then
        raise exception 'permission-denied' using errcode = '42501';
      end if;

      if existe then
        update public.fs_docs
           set data = newdata, version = cur.version + 1, updated_at = now()
         where col = v_col and id = v_id;
      else
        insert into public.fs_docs (col, id, data) values (v_col, v_id, newdata);
      end if;
    end if;
    n := n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'writes', n);
end $$;

revoke all on function public.fs_commit(jsonb, jsonb) from public;
revoke all on function public.fs_get(text, text) from public;
grant execute on function public.fs_commit(jsonb, jsonb) to anon, authenticated;
grant execute on function public.fs_get(text, text) to anon, authenticated;
grant execute on function public.fs_can_read(text, text, boolean) to anon, authenticated;

-- funções internas não precisam ser chamadas direto pela API
revoke execute on function public.fs_can_write(text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.fs_profile() from public, anon, authenticated;
grant execute on function public.fs_is_staff(), public.fs_is_manager(), public.fs_has_perm(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Tempo real
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fs_docs'
  ) then
    alter publication supabase_realtime add table public.fs_docs;
  end if;
end $$;
