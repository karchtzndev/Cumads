-- Abre e fecha a loja sozinho conforme os horários cadastrados, direto no
-- banco (a cada minuto, horário de Brasília) — não depende de nenhum
-- aparelho com o painel aberto.
--
-- Só age com o módulo "Abrir e fechar no horário" ligado (store/features.horario).
-- Respeita comando manual: se a equipe fechar antes (acabou a carne), o
-- automático só volta a mandar na próxima virada (mesma regra do painel).
create or replace function private.fs_horario_auto() returns text
language plpgsql security definer set search_path = public, private as $$
declare
  info jsonb;
  feats jsonb;
  agora timestamp := now() at time zone 'America/Sao_Paulo';
  hoje int := extract(dow from agora)::int;
  ontem int := (extract(dow from agora)::int + 6) % 7;
  minuto int := extract(hour from agora)::int * 60 + extract(minute from agora)::int;
  horarios jsonb;
  d jsonb;
  ini int; fim int;
  deve boolean := false;
  esta boolean;
  ov jsonb;
  chave text;
begin
  select data into feats from public.fs_docs where col = 'store' and id = 'features';
  if coalesce(feats->>'horario', 'false') <> 'true' then return 'módulo desligado'; end if;

  select data into info from public.fs_docs where col = 'store' and id = 'info' for update;
  if info is null then return 'sem dados da loja'; end if;

  horarios := coalesce(info->'horarios', jsonb_build_object(
    '0', '{"aberto":true,"abre":"19:00","fecha":"23:00"}'::jsonb,
    '1', '{"aberto":false}'::jsonb,
    '2', '{"aberto":true,"abre":"19:00","fecha":"23:00"}'::jsonb,
    '3', '{"aberto":true,"abre":"19:00","fecha":"23:00"}'::jsonb,
    '4', '{"aberto":true,"abre":"19:00","fecha":"23:00"}'::jsonb,
    '5', '{"aberto":true,"abre":"19:00","fecha":"23:00"}'::jsonb,
    '6', '{"aberto":true,"abre":"19:00","fecha":"23:00"}'::jsonb));

  -- expediente de hoje
  d := horarios->(hoje::text);
  if d is not null and d->>'aberto' = 'true' then
    ini := split_part(coalesce(d->>'abre','19:00'), ':', 1)::int * 60 + split_part(coalesce(d->>'abre','19:00'), ':', 2)::int;
    fim := split_part(coalesce(d->>'fecha','23:00'), ':', 1)::int * 60 + split_part(coalesce(d->>'fecha','23:00'), ':', 2)::int;
    if fim <= ini then fim := fim + 1440; end if;
    if minuto >= ini and minuto < fim then deve := true; end if;
  end if;
  -- expediente de ontem que passa da meia-noite
  d := horarios->(ontem::text);
  if not deve and d is not null and d->>'aberto' = 'true' then
    ini := split_part(coalesce(d->>'abre','19:00'), ':', 1)::int * 60 + split_part(coalesce(d->>'abre','19:00'), ':', 2)::int;
    fim := split_part(coalesce(d->>'fecha','23:00'), ':', 1)::int * 60 + split_part(coalesce(d->>'fecha','23:00'), ':', 2)::int;
    if fim <= ini and minuto < fim then deve := true; end if;
  end if;

  esta := coalesce(info->>'isOpen', 'true') <> 'false';
  if deve = esta then return case when esta then 'aberta (ok)' else 'fechada (ok)' end; end if;

  ov := info->'manualOverride';
  if jsonb_typeof(ov) = 'object' and (ov->>'esperado')::boolean is not distinct from deve then
    return 'comando manual respeitado';
  end if;

  chave := to_char(agora, 'YYYY-MM-DD') || ':' || case when deve then 'abrir' else 'fechar' end;
  if info->>'autoMark' = chave then return 'já processado'; end if;

  update public.fs_docs
     set data = data || jsonb_build_object('isOpen', deve, 'autoMark', chave, 'manualOverride', null),
         version = version + 1, updated_at = now()
   where col = 'store' and id = 'info';
  return case when deve then 'ABRIU' else 'FECHOU' end;
end $$;
revoke execute on function private.fs_horario_auto() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'cumads-horario';
select cron.schedule('cumads-horario', '* * * * *', 'select private.fs_horario_auto()');
