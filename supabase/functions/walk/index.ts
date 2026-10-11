// ぺたろぐ 歩数 function（iPhoneの「ショートカット」から歩数を受け取る）
// begin: アプリ（ログイン中）が合言葉を作る → ショートカットに渡す
// steps: ショートカットが合言葉と歩数・距離を送る（ログイン不要。合言葉は1日で使えなくなる）
// fetch: アプリが届いた歩数を受け取る
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
function secretKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return j.default ?? (Object.values(j)[0] as string) ?? "";
  } catch { return ""; }
}
const admin = createClient(SUPABASE_URL, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : null; };
const walkId = (v: unknown) => { const s = String(v ?? ""); return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : ""; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const task = String(body.task ?? "");

  // ショートカットから（ログインなし）
  if (task === "steps") {
    const k = String(body.k ?? "");
    if (!/^[a-z0-9]{24,40}$/.test(k)) return json({ error: "bad_request" }, 400);
    const steps = num(body.steps), km = num(body.km);
    if (steps == null || steps < 0 || steps > 300000) return json({ error: "bad_request" }, 400);
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const { data, error } = await admin.from("walk_steps").update({ steps: Math.round(steps), km: km != null && km >= 0 && km < 300 ? km : null, received_at: new Date().toISOString() })
      .eq("key", k).gte("created_at", since).select("walk_id");
    if (error) return json({ error: "server" }, 500);
    if (!data || !data.length) return json({ error: "expired" }, 404);
    return json({ ok: true });
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "login_required" }, 401);
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "login_required" }, 401);
  const uid = u.user.id;
  const args = (body.args ?? {}) as Record<string, unknown>;
  const wid = walkId(args.walk_id);
  if (!wid) return json({ error: "bad_request" }, 400);

  if (task === "begin") {
    const a = Number(args.start), b = Number(args.end);
    if (!isFinite(a) || !isFinite(b) || b <= a || b - a > 3 * 86400e3) return json({ error: "bad_request" }, 400);
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const key = Array.from(bytes, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 28);
    const { error } = await admin.from("walk_steps").insert({ key, user_id: uid, walk_id: wid, start_at: new Date(a).toISOString(), end_at: new Date(b).toISOString() });
    if (error) return json({ error: "server" }, 500);
    return json({ ok: true, result: { key } });
  }
  if (task === "fetch") {
    const { data } = await admin.from("walk_steps").select("steps, km, received_at").eq("user_id", uid).eq("walk_id", wid).not("received_at", "is", null).order("received_at", { ascending: false }).limit(1);
    const r = data && data[0];
    return json({ ok: true, result: r ? { steps: r.steps, km: r.km } : null });
  }
  return json({ error: "bad_request" }, 400);
});
