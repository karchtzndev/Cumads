-- Limpeza automática de dados que perdem utilidade com o tempo, para o
-- banco (plano grátis) não encher. Roda todo dia às 4h (horário de Brasília).
--   visitas ao site ........ 90 dias
--   registro de erros ...... 30 dias
--   histórico de acessos ... 180 dias
--   chamadas da TV ......... 30 dias
--   fila de impressão ...... 7 dias
-- Pedidos, clientes, caixa, estatísticas e mensagens NÃO são apagados.
create extension if not exists pg_cron;

create or replace function private.fs_limpeza() returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare
  resumo jsonb := '{}'::jsonb;
  n int;
  regra record;
begin
  for regra in
    select * from (values
      ('visitas',    interval '90 days'),
      ('errorLog',   interval '30 days'),
      ('acessos',    interval '180 days'),
      ('calls',      interval '30 days'),
      ('printQueue', interval '7 days')
    ) as t(col, idade)
  loop
    delete from public.fs_docs where col = regra.col and created_at < now() - regra.idade;
    get diagnostics n = row_count;
    resumo := resumo || jsonb_build_object(regra.col, n);
  end loop;
  return resumo;
end $$;
revoke execute on function private.fs_limpeza() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'cumads-limpeza';
select cron.schedule('cumads-limpeza', '0 7 * * *', 'select private.fs_limpeza()');
