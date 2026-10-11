// ぺたろぐ 図鑑 function（みんなのスタンプ図鑑: かんたん登録・第一発見者・地図の確かさ）
// - ログインした人だけが使える。AIは使わない（データベースだけ）
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
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);
const normKey = (v: unknown) => String(v ?? "").normalize("NFKC").toLowerCase().replace(/[\s・･,.、。()（）「」『』\[\]【】〈〉<>"'’‘“”!！?？~〜ー\-_/／|｜:：]/g, "");
const hexBits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
function ham(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 99;
  let d = 0; for (let i = 0; i < 16; i++) d += hexBits[parseInt(a[i], 16) ^ parseInt(b[i], 16)]; return d;
}
const SAME = 14;   // 64ビット中これ以下の差なら「同じデザイン」
const sameName = (x: unknown, y: unknown) => { const p = normKey(x), q = normKey(y); return !p || !q || p === q || p.includes(q) || q.includes(p); };

/* ---------- みんなのスタンプ図鑑（同じデザインを1つにまとめる） ----------
   match:    写真から切り抜いた直後に「みんなのデータに同じスタンプがあるか」をさがす（AIは使わない）
   register: 登録したスタンプを図鑑に入れる。まだなければ新しく作り、その人が第一発見者になる
   leave:    スタンプを消したときに図鑑からぬける
   ※ 同じ施設に図柄の似た別スタンプがあるので、画像の指紋だけでは同じと決めない（場所・名前も見る。最後は本人が選ぶ） */
const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : null; };
type DRow = { id: number; name: string; place: string; pref: string; cat: string; lat: number | null; lng: number | null; size_mm: number | null; digital: boolean; thumb: string | null; members: number; first_by: string | null; ham: number; near: boolean };
async function designFind(dh: string, lat: number | null, lng: number | null, digital: boolean, nearDeg: number, far: number, nearMax: number, limit = 6): Promise<DRow[]> {
  const { data, error } = await admin.rpc("design_find", { p_dh: dh, p_lat: lat, p_lng: lng, p_digital: digital, p_near_deg: nearDeg, p_far: far, p_near_max: nearMax, p_limit: limit });
  if (error) { console.error("design_find", error.message); return []; }
  return (data ?? []) as DRow[];
}
async function myDesigns(uid: string, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { data } = await admin.from("design_members").select("design_id").eq("user_id", uid).in("design_id", ids);
  return new Set((data ?? []).map((r: { design_id: number }) => r.design_id));
}
async function designs(uid: string, task: string, body: Record<string, unknown>) {
  const a = (body.args ?? {}) as Record<string, unknown>;
  const dh = /^[0-9a-f]{16}$/.test(String(a.dh ?? "")) ? String(a.dh) : "";
  const lat0 = num(a.lat), lng0 = num(a.lng); const hasLL = lat0 != null && lng0 != null && Math.abs(lat0) <= 90 && Math.abs(lng0) <= 180 && !(lat0 === 0 && lng0 === 0);
  const lat = hasLL ? lat0 : null, lng = hasLL ? lng0 : null, digital = a.digital === true;
  const sid = clip(a.stamp_id, 80).trim();

  if (task === "leave") {
    if (!sid) return json({ error: "bad_request" }, 400);
    const { data: rows } = await admin.from("design_members").delete().eq("user_id", uid).eq("stamp_id", sid).select("design_id");
    for (const r of rows ?? []) {
      const { count } = await admin.from("design_members").select("user_id", { count: "exact", head: true }).eq("design_id", r.design_id);
      if (!count) await admin.from("designs").delete().eq("id", r.design_id);
      else await admin.rpc("design_recount", { p_design: r.design_id });
    }
    return json({ ok: true });
  }
  if (!dh) return json({ error: "bad_request" }, 400);

  if (task === "match") {
    const rows = await designFind(dh, lat, lng, digital, 0.01, 8, 14, 8);
    const mine = await myDesigns(uid, rows.map((r) => r.id));
    const out = rows.filter((r) => r.near ? r.ham <= 14 : r.ham <= 8).slice(0, 3).map((r) => ({
      id: r.id, name: r.name, place: r.place, pref: r.pref, cat: r.cat, lat: r.lat, lng: r.lng, size_mm: r.size_mm, thumb: r.thumb, members: r.members, near: r.near, ham: r.ham, mine: mine.has(r.id),
    }));
    return json({ ok: true, result: { list: out } });
  }

  // register
  if (!sid) return json({ error: "bad_request" }, 400);
  const name = clip(a.name, 80).trim(), place = clip(a.place, 80).trim(), pref = clip(a.pref, 10).trim(), cat = clip(a.cat, 20).trim();
  const size = num(a.size_mm), t = num(a.t) ?? Date.now(), thumb = /^data:image\/(png|jpeg|webp);base64,/.test(String(a.thumb ?? "")) && String(a.thumb).length < 60000 ? String(a.thumb) : null;
  // 前にこのスタンプで入っていたら、まずそこからぬける（名前や絵を直したとき）
  const { data: was } = await admin.from("design_members").select("design_id").eq("user_id", uid).eq("stamp_id", sid);
  let pick: number | null = null;
  const want = num(a.design);
  if (want != null) {
    const { data: d } = await admin.from("designs").select("id, dh, digital").eq("id", want).maybeSingle();
    if (d && d.digital === digital && ham(dh, String(d.dh ?? "")) <= SAME) pick = d.id;
  }
  if (pick == null) {
    const rows = await designFind(dh, lat, lng, digital, 0.004, 6, SAME, 8);
    const mine = await myDesigns(uid, rows.map((r) => r.id));
    const keep = new Set((was ?? []).map((r: { design_id: number }) => r.design_id));
    for (const r of rows) {
      if (mine.has(r.id) && !keep.has(r.id)) continue;   // 自分がもう別のスタンプで入っている図柄は、同じ場所の別スタンプのことが多い
      if (!sameName(name, r.name) && !(r.near && r.ham <= 8)) continue;
      if (!r.near && !sameName(name, r.name)) continue;
      pick = r.id; break;
    }
  }
  let isNew = false;
  if (pick == null) {
    const { data: d, error } = await admin.from("designs").insert({ dh, lat, lng, name, place, pref, cat, size_mm: size, digital, thumb, first_by: uid, first_stamp: sid, first_t: t }).select("id").single();
    if (error || !d) { console.error("design insert", error?.message); return json({ error: "server" }, 500); }
    pick = d.id; isNew = true;
  } else {
    // 足りない情報をうめる（大きさ・ジャンル・小さな絵）
    const { data: d } = await admin.from("designs").select("size_mm, cat, thumb, lat").eq("id", pick).maybeSingle();
    const up: Record<string, unknown> = {};
    if (d && d.size_mm == null && size != null) up.size_mm = size;
    if (d && !d.cat && cat) up.cat = cat;
    if (d && !d.thumb && thumb) up.thumb = thumb;
    if (d && d.lat == null && lat != null) { up.lat = lat; up.lng = lng; }
    if (Object.keys(up).length) await admin.from("designs").update(up).eq("id", pick);
  }
  for (const r of was ?? []) if (r.design_id !== pick) {
    await admin.from("design_members").delete().eq("user_id", uid).eq("stamp_id", sid).eq("design_id", r.design_id);
    const { count } = await admin.from("design_members").select("user_id", { count: "exact", head: true }).eq("design_id", r.design_id);
    if (!count) await admin.from("designs").delete().eq("id", r.design_id); else await admin.rpc("design_recount", { p_design: r.design_id });
  }
  const { data: j, error: je } = await admin.rpc("design_join", { p_design: pick, p_user: uid, p_stamp: sid, p_t: Math.round(t) });
  if (je) { console.error("design_join", je.message); return json({ error: "server" }, 500); }
  const row = Array.isArray(j) ? j[0] : j;
  return json({ ok: true, result: { design: pick, first: row?.first_by === uid, members: row?.members ?? 1, isNew } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "login_required" }, 401);
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "login_required" }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const task = String(body.task ?? "");
  if (task === "match" || task === "register" || task === "leave") return await designs(u.user.id, task, body);
  return json({ error: "bad_request" }, 400);
});
