# 🍢 Cumad's Grill — PWA

Site de pedidos, painel da equipe e TV de chamada do **Cumad's Grill** — espetinhos
na brasa, jantinhas, porções, cremes e pastéis.

| App | Caminho | Para quem |
|---|---|---|
| 🛍️ Cliente | `/` | cardápio, carrinho, pedido (entrega, balcão ou mesa), acompanhamento em tempo real |
| 📊 Gerencial | `/gerencial/` | equipe: pedidos, cozinha, mesas, caixa, cardápio, cupons, clientes, relatórios |
| 📺 Chamada | `/chamada/` | TV da loja: números chamados com aviso sonoro |

Os três são PWAs (instaláveis no celular, com service worker). Não há etapa de build:
é HTML/CSS/JS puro, publicado como site estático na Vercel.

## Identidade visual

Cores tiradas da logo:

| Uso | Cor |
|---|---|
| Vermelho do anel (cabeçalho, botões, faixas) | `#a8341f` |
| Marrom do contorno (textos) | `#391b14` |
| Dourado das estrelas (filetes, destaques) | `#f2c94c` |
| Creme das letras (fundo) | `#fbf3df` |

Fontes: **Lobster** (marca), **Alfa Slab One** (títulos) e **Montserrat** (texto).
Os títulos de seção usam a faixa vermelha "pincelada" com ★, como no cardápio impresso.

## Banco de dados (Supabase)

Projeto `cumads-grill` (`usgykpjvptlxhmspsadn`, região São Paulo).

As telas usam uma API de documentos (coleção → documento → JSON). O arquivo
`supa-firebase.js` implementa essa API em cima do Supabase:

- **Dados:** tabela `public.fs_docs (col, id, data jsonb, version)` — um documento por linha.
- **Leitura:** RLS para listas e a RPC `fs_get` para um documento pelo id.
- **Escrita:** somente pela RPC `fs_commit`, que aplica as regras de acesso de cada coleção
  e resolve incrementos/listas de forma atômica. Transações usam checagem de versão com
  nova tentativa automática (usada, por exemplo, na numeração diária dos pedidos).
- **Tempo real:** Supabase Realtime, com atualização periódica como rede de segurança.
- **Contas:** Supabase Auth. A edge function `criar-conta` cria contas já confirmadas
  (cliente com conta de fidelidade e funcionário cadastrado pelo gerente). O acesso ao
  painel vem do documento `users/{uid}`, que só o gerente grava.
- **Troca de senha sem e-mail:** a edge function `alterar-senha` deixa cada pessoa trocar a
  própria senha (botão 🔑 no topo do painel) e o gerente definir a senha de alguém da equipe
  (Ajustes → Equipe → 🔑).

### Recriar do zero

1. Rode `supabase/migrations/0001_fs_docs.sql` e `0002_fs_helpers_private.sql` no SQL Editor.
2. Publique `supabase/functions/criar-conta` e `supabase/functions/alterar-senha`
   (sem verificação de JWT — as funções validam os dados e a sessão sozinhas).
3. Crie a conta do gerente (Authentication → Add user, com "auto confirm") e rode
   `supabase/seed.sql` trocando o e-mail no final.
4. Troque `supabaseUrl`/`supabaseKey` nos três `index.html` (procure `firebaseConfig`).

### Tarefas automáticas

- **Limpeza diária** (pg_cron, 4h de Brasília — `supabase/migrations/0004_limpeza_automatica.sql`):
  apaga visitas com mais de 90 dias, erros com mais de 30, acessos com mais de 180,
  chamadas da TV com mais de 30 e fila de impressão com mais de 7. Pedidos, clientes,
  caixa, estatísticas e mensagens nunca são apagados.
- **Manter ativo** (cron da Vercel, 1x por dia → `api/manter-ativo.js`): faz uma leitura
  no banco para o Supabase gratuito não pausar o projeto por inatividade.

### Configurações recomendadas no painel do Supabase

- **Authentication → URL Configuration → Site URL:** o endereço do site na Vercel
  (sem isso o link de "esqueci minha senha" aponta para `localhost`). Adicione também
  `https://SEU-SITE/gerencial/` em *Redirect URLs*.
- **Authentication → Password security:** ligue *Leaked password protection*.
- **Authentication → Emails → Reset Password:** cole o modelo em português de
  `docs/email-recuperar-senha.html` (o assunto está no topo do arquivo).

## Deploy

Vercel, projeto ligado a este repositório (branch `main`), Framework = *Other*, sem build.

## Cardápio e preços

Itens do cardápio impresso. **Os preços são sugestões iniciais** (o impresso não tinha
preços) — ajuste em Gerencial → Gestão → Cardápio. Bebidas e adicionais (vinagrete,
farofa, torresmo) também são sugestões e podem ser pausados ou apagados por lá.
