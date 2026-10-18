// ぺたろぐ 取り込み function（掲載許可ずみのスタンプ紹介サイトから、みんなの地図用の下書きを作る）
// - AIは使わない。サイトのデータを機械的に読み、住所から位置を出して jsh_items に入れる
// - POST {key, page, per}: 2年以内に登録されたスタンプを1ページぶん取り込む（key は hq_kv の import_key）
// - GET ?img=URL: 確認画面で画像を加工できるよう、そのサイトの画像だけを中継する
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
function secretKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return j.default ?? (Object.values(j)[0] as string) ?? ""; } catch { return ""; }
}
const admin = createClient(SUPABASE_URL, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });
const SITE = "https://japan-stamp-hunt.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const UA = { "User-Agent": "petalog-import/1.0 (+https://petalog-stamp.github.io/)" };
const PALACE = { lat: 35.6852, lng: 139.7528 };   // 皇居

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#8211": "–", "#8212": "—", "#8217": "’", "#8220": "“", "#8221": "”", "#038": "&" };
const dec = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => ENT[e] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : m));
const strip = (s: string) => dec(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t　]+/g, " ").trim();
const jpOnly = (t: string) => t.replace(/\s*[\(（][^()（）]*[A-Za-z]{3}[^()（）]*[\)）]\s*$/, "").trim();
function km(a: number, b: number, c: number, d: number) { const R = 6371, t = Math.PI / 180, x = Math.sin((c - a) * t / 2), y = Math.sin((d - b) * t / 2); return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * t) * Math.cos(c * t) * y * y)); }

// サイトのテーマ → ぺたろぐのジャンル（上から優先）
function catOf(th: string[]): string {
  const has = (...k: string[]) => th.some((t) => k.includes(t));
  if (has("期間限定", "大阪万博2025")) return "イベント";
  if (has("駅スタンプ", "JR78駅スタンプ")) return "駅";
  if (has("空港")) return "空港";
  if (has("フェリー")) return "港";
  if (has("道の駅")) return "道の駅";
  if (has("高速道路")) return "インターチェンジ";
  return "施設";
}
const PREF = /^(北海道|東京都|京都府|大阪府|.{2,3}県)/;
const isAddr = (l: string) => /〒\s*\d{3}\s*[-‐－−ー]?\s*\d{4}/.test(l) || (PREF.test(l) && /[0-9０-９]/.test(l) && /[市区町村郡]/.test(l));
const SKIP_H = /台紙|パンフ|外観|設置|案内図|マップ|地図|アクセス|スタンプ台(?!紙)|map|access/i;
const GENERIC = /^(第\s*\d+\s*[弾期回]|\d+|.*スタンプ|.*限定.*|[春夏秋冬].*)$/;

function cleanAddr(a: string) {
  return a.normalize("NFKC").replace(/〒?\s*\d{3}-?\d{4}/, "").replace(/[‐－−ー―]/g, "-").replace(/\s+/g, "").replace(/(\d+-\d+(-\d+)?).*/, "$1").trim();
}
async function gsi(q: string): Promise<{ lat: number; lng: number; t: string } | null> {
  try {
    const r = await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(q), { headers: UA, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return null;
    const [lng, lat] = j[0].geometry.coordinates; return { lat: +lat, lng: +lng, t: String(j[0].properties?.title ?? "") };
  } catch { return null; }
}
async function nomi(q: string, pref = ""): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=jp&q=" + encodeURIComponent(q), { headers: { ...UA, "Accept-Language": "ja" }, signal: AbortSignal.timeout(8000) });
    const j = await r.json(); await new Promise((ok) => setTimeout(ok, 1100));
    const hit = Array.isArray(j) ? j.find((x: { display_name?: string }) => !pref || String(x.display_name ?? "").includes(pref)) : null;
    return hit ? { lat: +hit.lat, lng: +hit.lon } : null;
  } catch { return null; }
}
const geoCache = new Map<string, { lat: number; lng: number; g: string } | null>();
async function locate(addr: string, place: string, pref: string) {
  const k = addr + "|" + place; if (geoCache.has(k)) return geoCache.get(k)!;
  let out: { lat: number; lng: number; g: string } | null = null;
  if (addr) { const c = cleanAddr(addr); const r = c ? await gsi(c) : null; if (r && (!pref || r.t.startsWith(pref) || !PREF.test(r.t))) out = { lat: r.lat, lng: r.lng, g: "town" }; }
  // 住所は丁目までのことが多いので、施設名でもさがして近ければ（1.5km以内）そちらを使う
  if (place) { const r = await nomi(`${place} ${pref}`.trim(), pref); if (r && (!out || km(out.lat, out.lng, r.lat, r.lng) < 1.5)) out = { ...r, g: out ? "name+addr" : "name" }; }
  geoCache.set(k, out); return out;
}

function datesIn(s: string): number[] {
  const out: number[] = []; const t = s.normalize("NFKC");
  for (const m of t.matchAll(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g)) out.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // 「2026年10月1日～11月23日」の後ろ側（年なし）
  for (const m of t.matchAll(/(\d{4})年\s*\d{1,2}月\s*\d{1,2}日\s*[～〜~\-ー]\s*(\d{1,2})月\s*(\d{1,2})日/g)) out.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return out;
}

type Post = { id: number; date: string; link: string; title: { rendered: string }; content: { rendered: string }; prefecture: number[]; theme: number[]; stamp_tag: number[] };
async function terms(tx: string): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  const r = await fetch(`${SITE}/wp-json/wp/v2/${tx}?per_page=100&_fields=id,name`, { headers: UA }); const j = await r.json();
  if (Array.isArray(j)) for (const t of j) m.set(t.id, dec(t.name)); return m;
}

function parse(p: Post, TH: Map<number, string>, TG: Map<number, string>, PF: Map<number, string>) {
  const html = p.content?.rendered ?? "";
  const title = jpOnly(strip(p.title?.rendered ?? ""));
  const themes = (p.theme ?? []).map((i) => TH.get(i) ?? "").filter(Boolean);
  const tags = (p.stamp_tag ?? []).map((i) => TG.get(i) ?? "").filter((t) => t && !/^Contributor-/i.test(t));
  const pref = (p.prefecture ?? []).map((i) => PF.get(i) ?? "").filter(Boolean)[0] ?? "";
  // 情報の箇条書き（最初の <ul> が日本語）
  const ul = (html.match(/<ul>[\s\S]*?<\/ul>\s*<\/li>\s*<\/ul>|<ul>[\s\S]*?<\/ul>/) ?? [""])[0];
  const lines = ul.replace(/<\/?(ul|li)[^>]*>/gi, "\n").split("\n").map(strip).filter(Boolean);
  const addrs = lines.filter(isAddr);
  const ai = lines.findIndex(isAddr);
  let place = ai > 0 ? lines[ai - 1] : "";
  if (/[：:]$/.test(place) || place === title) place = ai > 1 && !/[：:]$/.test(lines[ai - 2]) && lines[ai - 2] !== title ? lines[ai - 2] : (place === title ? title : "");
  const memo = lines.filter((l, i) => !(i === 0 && (l === title || jpOnly(l) === title))).join("\n").slice(0, 500);
  // 画像（見出しごと）
  const parts = html.split(/<h2[^>]*>/i); const imgs: { src: string; w: number; h: number; sub: string; day: string }[] = [];
  parts.forEach((part, k) => {
    let head = "", body = part;
    if (k > 0) { const e = part.indexOf("</h2>"); head = strip(part.slice(0, e)); body = part.slice(e + 5); }
    if (head && SKIP_H.test(head)) return;
    body = body.replace(/<ul>[\s\S]*$/i, (m) => m.replace(/<img[^>]*>/gi, ""));   // 箇条書きの中の画像は使わない
    for (const m of body.matchAll(/<img[^>]*>([^<]{0,40})/gi)) {
      const tag = m[0]; const src = (tag.match(/src="([^"]+)"/) ?? [])[1] ?? "";
      if (!src.startsWith(SITE + "/wp-content/uploads/")) continue;
      const w = +((tag.match(/width="(\d+)"/) ?? [])[1] ?? 0), h = +((tag.match(/height="(\d+)"/) ?? [])[1] ?? 0);
      if (/\.jpe?g$/i.test(src) && Math.max(w, h) >= 800) continue;   // 大きな写真は台紙やスタンプ台の写真
      const dm = (m[1] ?? "").match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
      const day = dm ? new Date(`${dm[1]} ${dm[2]}, ${dm[3]} UTC`).toISOString().slice(0, 10) : "";
      imgs.push({ src, w, h, sub: head, day });
    }
  });
  const now = Date.now();
  const ds = datesIn(memo);
  const ended = themes.includes("大阪万博2025") || (themes.includes("期間限定") && ds.length > 0 && Math.max(...ds) + 86400000 < now);
  return { title, themes, tags, pref, addrs, place: place || title, memo, imgs, ended, cat: catOf(themes), overlap: themes.includes("重ね押し") };
}

async function importPage(page: number, per: number, after: string) {
  const r = await fetch(`${SITE}/wp-json/wp/v2/stamps?per_page=${per}&page=${page}&after=${encodeURIComponent(after)}&orderby=date&order=desc&_fields=id,date,link,title,content,prefecture,theme,stamp_tag`, { headers: UA });
  if (r.status === 400) return { page, done: true, items: 0 };
  const total = +(r.headers.get("x-wp-total") ?? 0), pages = +(r.headers.get("x-wp-totalpages") ?? 0);
  const posts = (await r.json()) as Post[];
  const [TH, TG, PF] = await Promise.all([terms("theme"), terms("stamp_tag"), terms("prefecture")]);
  const ids = posts.map((p) => p.id);
  const { data: done } = await admin.from("jsh_items").select("post_id").in("post_id", ids).neq("status", "new");
  const keep = new Set((done ?? []).map((d: { post_id: number }) => d.post_id));
  const rows: Record<string, unknown>[] = []; let noloc = 0;
  for (const p of posts) {
    if (keep.has(p.id)) continue;
    const x = parse(p, TH, TG, PF);
    const loc0 = await locate(x.addrs[0] ?? "", x.place, x.pref);
    const list = x.imgs.length ? x.imgs : [{ src: "", w: 0, h: 0, sub: "", day: "" }];
    // 何か所もまわるスタンプラリー: 見出しが場所の名前なら、その場所でさがす
    const multi = new Set(list.map((m) => m.sub)).size > 1 && (x.addrs.length !== 1);
    for (const [i, im] of list.entries()) {
      let loc = loc0;
      if (multi && im.sub && !GENERIC.test(im.sub)) { const r = await locate("", im.sub, x.pref); if (r) loc = r; }
      if (!loc) noloc++;
      const name = list.length > 1 && im.sub && !/^(第\s*\d+\s*[弾期回]|\d+)$/.test(im.sub) ? `${x.title}・${im.sub}` : list.length > 1 && im.sub ? `${x.title}（${im.sub}）` : x.title;
      rows.push({
        post_id: p.id, idx: i, posted: p.date + "+09:00", link: p.link, title: x.title, sub: im.sub || null, name: name.slice(0, 80), place: x.place.slice(0, 80),
        addr: x.addrs[0] ?? null, addrs: x.addrs, memo: x.memo, pref: x.pref, themes: x.themes, tags: x.tags, cat: x.cat, overlap: x.overlap, ended: x.ended,
        img: im.src || null, img_w: im.w || null, img_h: im.h || null, nimg: list.length, day: im.day || null,
        lat: loc?.lat ?? null, lng: loc?.lng ?? null, geo: loc?.g ?? null, dist_km: loc ? km(PALACE.lat, PALACE.lng, loc.lat, loc.lng) : 99999,
        status: !im.src ? "noimg" : x.ended ? "ended" : "new",
      });
    }
  }
  const fresh = ids.filter((i) => !keep.has(i));
  if (fresh.length) await admin.from("jsh_items").delete().in("post_id", fresh).in("status", ["new", "ended", "noimg"]);
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await admin.from("jsh_items").upsert(rows.slice(i, i + 100), { onConflict: "post_id,idx" });
    if (error) return { page, error: error.message };
  }
  return { page, total, pages, posts: posts.length, items: rows.length, noloc, done: page >= pages };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  if (req.method === "GET" && u.searchParams.get("img")) {
    const src = u.searchParams.get("img") ?? "";
    if (!src.startsWith(SITE + "/wp-content/uploads/")) return json({ error: "bad" }, 400);
    const r = await fetch(src, { headers: UA });
    if (!r.ok) return json({ error: "fetch" }, 502);
    return new Response(r.body, { headers: { ...CORS, "Content-Type": r.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "public, max-age=604800" } });
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Record<string, unknown>; try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { data: kv } = await admin.from("hq_kv").select("v").eq("k", "import_key").maybeSingle();
  if (!kv || b.key !== kv.v) return json({ error: "forbidden" }, 403);
  const after = new Date(Date.now() - 2 * 365.25 * 86400000).toISOString().slice(0, 19);
  const page = Math.max(1, Number(b.page) || 1), per = Math.min(100, Math.max(1, Number(b.per) || 40));
  try { return json(await importPage(page, per, after)); } catch (e) { return json({ error: String(e) }, 500); }
});
