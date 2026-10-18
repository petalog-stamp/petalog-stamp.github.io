// 一時的な検証用: インクの形の指紋で、同じスタンプを見分けられるか確かめる（結果の数字だけ返す）
import { createClient } from "npm:@supabase/supabase-js@2";
import UPNG from "npm:upng-js@2.1.0";
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

function alphaOf(buf: ArrayBuffer) {
  const img = UPNG.decode(buf); const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]); const W = img.width, H = img.height;
  const A = new Float32Array(W * H); for (let i = 0; i < W * H; i++) A[i] = rgba[i * 4 + 3] / 255; return { A, W, H };
}
// インクの形: 外枠にぴったり合わせて正方形にし、N×Nに縮めて少しぼかす
function fp({ A, W, H }: { A: Float32Array; W: number; H: number }, N = 32) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (A[y * W + x] > 0.3) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, S = Math.max(bw, bh), ox = x0 - (S - bw) / 2, oy = y0 - (S - bh) / 2;
  const G = new Float32Array(N * N), C = new Float32Array(N * N);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const gx = Math.min(N - 1, Math.floor((x - ox) / S * N)), gy = Math.min(N - 1, Math.floor((y - oy) / S * N)); G[gy * N + gx] += A[y * W + x]; C[gy * N + gx]++; }
  for (let i = 0; i < N * N; i++) G[i] = C[i] ? G[i] / C[i] : 0;
  const B = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < N && Y < N) { s += G[Y * N + X]; n++; } } B[y * N + x] = s / n; }
  let m = 0; for (const v of B) m += v; m /= B.length; let sd = 0; for (const v of B) sd += (v - m) ** 2; sd = Math.sqrt(sd / B.length) || 1;
  return { z: B.map((v) => (v - m) / sd), N, ar: bw / bh };
}
function rot(z: Float32Array, N: number, r: number) { if (!r) return z; const o = new Float32Array(N * N); for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const [X, Y] = r === 1 ? [N - 1 - y, x] : r === 2 ? [N - 1 - x, N - 1 - y] : [y, N - 1 - x]; o[Y * N + X] = z[y * N + x]; } return o; }
function sim(a: { z: Float32Array; N: number }, b: { z: Float32Array; N: number }) { let best = -1; for (let r = 0; r < 4; r++) { const bz = rot(b.z, b.N, r); let s = 0; for (let i = 0; i < a.z.length; i++) s += a.z[i] * bz[i]; best = Math.max(best, s / a.z.length); } return best; }

Deno.serve(async (req) => {
  const b = await req.json();
  const { data: kv } = await admin.from("hq_kv").select("v").eq("k", "import_key").maybeSingle();
  if (!kv || b.key !== kv.v) return new Response("forbidden", { status: 403 });
  const mine: { id: string; path: string }[] = b.mine, cat: { id: number; url: string }[] = b.cat;
  const fa = [], fb = [];
  for (const m of mine) { const { data } = await admin.storage.from("cuts").download(m.path); fa.push(data ? fp(alphaOf(await data.arrayBuffer())) : null); }
  for (const c of cat) { const r = await fetch(c.url); fb.push(r.ok ? fp(alphaOf(await r.arrayBuffer())) : null); }
  const M = fa.map((a) => fb.map((x) => (a && x ? Math.round(sim(a, x) * 100) / 100 : null)));
  return new Response(JSON.stringify({ M, ar: [fa.map((a) => a && a.ar.toFixed(2)), fb.map((a) => a && a.ar.toFixed(2))] }), { headers: { "Content-Type": "application/json" } });
});
