// Mantém o banco (Supabase, plano grátis) acordado.
//
// O Supabase pausa projetos gratuitos depois de 7 dias sem uso — site e
// painel parariam até alguém reativar pelo painel do Supabase. A Vercel
// chama este endereço uma vez por dia (ver "crons" no vercel.json) e ele
// faz uma leitura simples e pública (dados da loja) no banco.
const SUPABASE_URL = 'https://usgykpjvptlxhmspsadn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_5SM2AKsMK66DfMQ7SPGTGA_1ID4IU28'; // chave pública

module.exports = async (req, res) => {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/fs_get', {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_col: 'store', p_id: 'info' })
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status, quando: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ ok: false, erro: String(e && e.message || e) });
  }
};
