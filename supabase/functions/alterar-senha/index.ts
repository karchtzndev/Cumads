// Troca de senha sem depender de e-mail.
//
// - Qualquer pessoa logada pode trocar a PRÓPRIA senha.
// - Gerente ativo pode definir a senha de qualquer conta da equipe.
//
// Quem chama é identificado pelo token de sessão (Authorization: Bearer ...),
// conferido aqui mesmo com o Supabase Auth.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "not signed in" }, 401);

  let body: { uid?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid request" }, 400);
  }
  const alvo = String(body.uid || "");
  const senha = String(body.password || "");
  if (senha.length < 6) return json({ error: "password should be at least 6 characters" }, 400);
  if (senha.length > 72) return json({ error: "password too long (max 72 characters)" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: quem, error: errQuem } = await admin.auth.getUser(token);
  if (errQuem || !quem?.user) return json({ error: "not signed in" }, 401);
  const eu = quem.user.id;
  const destino = alvo || eu;

  if (destino !== eu) {
    const { data: perfil } = await admin
      .from("fs_docs").select("data").eq("col", "users").eq("id", eu).maybeSingle();
    const p = (perfil?.data || {}) as { role?: string; active?: boolean };
    if (p.role !== "gerente" || p.active !== true) {
      return json({ error: "only a manager can change another person's password" }, 403);
    }
    // gerente só mexe em contas da equipe
    const { data: equipe } = await admin
      .from("fs_docs").select("id").eq("col", "users").eq("id", destino).maybeSingle();
    if (!equipe) return json({ error: "account is not part of the team" }, 404);
  }

  const { error } = await admin.auth.admin.updateUserById(destino, { password: senha });
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
});
