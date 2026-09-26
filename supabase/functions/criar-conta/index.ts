// Cria conta de e-mail/senha já confirmada.
//
// Usado por:
//  - cliente que cria a conta opcional (fidelidade) no site
//  - gerente que cadastra funcionário no painel
//
// Conta nova não ganha poder nenhum sozinha: o que dá acesso ao painel é o
// documento users/{uid}, que só um gerente consegue gravar (regras no banco).
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

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid email" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
    return json({ error: "invalid email" }, 400);
  }
  if (password.length < 6) {
    return json({ error: "password should be at least 6 characters" }, 400);
  }
  if (password.length > 72) {
    return json({ error: "password too long (max 72 characters)" }, 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    const msg = /already|exists|registered/i.test(error.message)
      ? "email already registered"
      : error.message;
    return json({ error: msg }, 400);
  }

  return json({ uid: data.user.id, email: data.user.email });
});
