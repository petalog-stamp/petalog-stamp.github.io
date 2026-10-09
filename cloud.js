/* ぺたろぐ web版: ログインとアカウント保存（Supabase）
   このファイルはWeb版だけで読み込まれます。読み込まれていないとき（Claudeのアーティファクト版）は今まで通り動きます。 */
(function () {
  "use strict";
  const CFG = {
    url: "https://xwhmmgqmiefnhcdpbuoz.supabase.co",
    key: "sb_publishable_ms34cIpwJimlU2tbgklmsw_t0vqQXSb",
  };
  const LS_SKIP = "petalog.skipLogin";
  const SS_ASKED = "petalog.loginAsked";
  const PLACEHOLDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  };

  // ログイン直後に「この画面では保存できなかった」ときは、ログイン情報をURLで渡して読み込み直す（このしるしで判断）
  const memLogin = /[#&]pl_mem=1/.test(location.hash);
  const storeOK = () => { try { const k = "petalog.ping"; localStorage.setItem(k, String(Date.now())); return !!localStorage.getItem(k); } catch { return false; } };
  let sb = null;
  try {
    if (window.supabase && supabase.createClient) {
      sb = supabase.createClient(CFG.url, CFG.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "petalog-auth", flowType: "implicit" },
      });
    }
  } catch (e) { console.warn("supabase init", e); }

  let user = null, uid = null, attached = false, recovery = false, offline = false;
  // remember the last good copy of the records, so the app still opens when the network or server is down
  const snap = {
    async get(k) { return Cache.get("kv", `${k}:${uid}`); },
    put(k, v) { Cache.put("kv", `${k}:${uid}`, v); },
  };
  // the Supabase library retries failed reads for a while; when there is no connection we must not wait for that
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const sig = ms => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  const noNet = () => offline || navigator.onLine === false;
  // one quick retry of our own instead of the library's long back-off; after that, use the saved copy
  const ask = q => within(q.retry(false).abortSignal(sig(8000)), 9000).then(r => { if (r.error) fail(r.error); return r; });
  const twice = async mk => { try { return await ask(mk()); } catch (e) { if (noNet()) throw e; await new Promise(r => setTimeout(r, 700)); try { return await ask(mk()); } catch (e2) { offline = true; throw e2; } } };
  const netErr = e => !navigator.onLine || /fetch|network|load failed|timed? ?out|offline/i.test(String((e && (e.message || e.name)) || e || ""));

  /* ---------- tiny IndexedDB cache (cut images, community rows) ---------- */
  const Cache = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res) => {
        try {
          const r = indexedDB.open("petalog-cache", 1);
          r.onupgradeneeded = () => { const d = r.result; ["cuts", "kv"].forEach((n) => d.objectStoreNames.contains(n) || d.createObjectStore(n)); };
          r.onsuccess = () => { this.db = r.result; res(this.db); };
          r.onerror = () => res(null);
          r.onblocked = () => res(null);
        } catch { res(null); }
      });
    },
    async op(store, mode, fn) {
      const db = await this.open(); if (!db) return null;
      return new Promise((res) => {
        try {
          const tx = db.transaction(store, mode); const q = fn(tx.objectStore(store));
          tx.oncomplete = () => res(q && q.result); tx.onerror = () => res(null); tx.onabort = () => res(null);
        } catch { res(null); }
      });
    },
    get(store, k) { return this.op(store, "readonly", (s) => s.get(k)); },
    put(store, k, v) { return this.op(store, "readwrite", (s) => s.put(v, k)); },
    del(store, k) { return this.op(store, "readwrite", (s) => s.delete(k)); },
    async wipe() { try { if (this.db) { this.db.close(); this.db = null; } indexedDB.deleteDatabase("petalog-cache"); } catch {} },
  };

  /* ---------- helpers ---------- */
  function toBlob(dataUrl) {
    const [head, b64] = String(dataUrl).split(",");
    const mime = (head.match(/:(.*?);/) || [])[1] || "application/octet-stream";
    const bin = atob(b64 || ""); const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: mime });
  }
  function toDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function toB64(blob) { return (await toDataUrl(blob)).split(",")[1]; }
  function loadImage(blob) {
    return new Promise((res, rej) => { const u = URL.createObjectURL(blob); const i = new Image(); i.onload = () => { URL.revokeObjectURL(u); res(i); }; i.onerror = (e) => { URL.revokeObjectURL(u); rej(e); }; i.src = u; });
  }
  // re-encode an image so it fits the size limit (keeps transparency for PNG when possible)
  async function fit(blob, maxBytes, opt = {}) {
    if (blob.size <= maxBytes && !opt.force) return blob;
    const im = await loadImage(blob);
    let scale = Math.min(1, (opt.maxEdge || 4096) / Math.max(im.width, im.height));
    for (let round = 0; round < 6; round++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(im.width * scale)); c.height = Math.max(1, Math.round(im.height * scale));
      const x = c.getContext("2d");
      const png = blob.type === "image/png" && !opt.flatten;
      if (!png) { x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); }
      x.drawImage(im, 0, 0, c.width, c.height);
      const out = await new Promise((r) => c.toBlob(r, png ? "image/png" : "image/jpeg", png ? undefined : 0.86));
      if (out && out.size <= maxBytes) return out;
      scale *= 0.8;
    }
    throw { code: "too_big" };
  }
  const safeKey = (k) => String(k).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : v != null && v !== "" && isFinite(+v) ? +v : null);
  async function pool(items, n, fn) {
    let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  }
  function fail(error) { const e = new Error((error && error.message) || "cloud"); e.code = (error && error.code) || "error"; e.cause = error; throw e; }

  async function upload(bucket, path, blob, upsert) {
    const { error } = await sb.storage.from(bucket).upload(path, await blob.arrayBuffer(), { contentType: blob.type || "image/png", upsert: !!upsert, cacheControl: "31536000" });
    if (error) fail(error);
  }
  async function download(bucket, path) {
    const { data, error } = await sb.storage.from(bucket).download(path);
    if (error || !data) return null;
    return data;
  }
  async function removeFiles(bucket, paths) {
    const list = paths.filter(Boolean); if (!list.length) return;
    try { await sb.storage.from(bucket).remove(list); } catch {}
  }

  /* ---------- cut images ---------- */
  const cutState = new Map(); // stamp id -> { path, url }
  const cutFailed = new Set();
  async function cutFor(path) {
    const hit = await Cache.get("cuts", path);
    if (hit) return hit;
    if (noNet()) return null;
    const b = await download("cuts", path);
    if (!b) return null;
    const url = await toDataUrl(b);
    Cache.put("cuts", path, url);
    return url;
  }

  /* ---------- Store methods used when logged in ---------- */
  const methods = {
    async listStamps() {
      let rows = [];
      try {
        if (noNet()) throw new Error("offline");
        for (let from = 0; ; from += 1000) {
          const { data } = await twice(() => sb.from("stamps").select("id,data,cut_path").eq("user_id", uid).order("id").range(from, from + 999));
          rows.push(...data); if (data.length < 1000) break;
        }
        snap.put("stamps", rows);
      } catch (e) {
        const old = await snap.get("stamps"); if (!old) throw e;
        rows = old; offline = true;
      }
      const out = [];
      await pool(rows, 6, async (r) => {
        const s = { ...(r.data || {}), id: r.id }; delete s.kind;
        let url = r.cut_path ? await cutFor(r.cut_path).catch(() => null) : null;
        if (!url) { url = PLACEHOLDER; cutFailed.add(r.id); }
        s.cut = url;
        cutState.set(r.id, { path: r.cut_path, url });
        out.push(s);
      });
      return out;
    },
    async saveStamp(s) {
      const body = this.clean({ ...s }); delete body.sample; delete body.kind;
      const cut = body.cut; delete body.cut;
      const prev = cutState.get(s.id);
      let path = prev ? prev.path : null, oldPath = null, fresh = null;
      const changed = cut && /^data:image\//.test(cut) && cut !== PLACEHOLDER && (!prev || prev.url !== cut);
      if (changed) {
        const blob = await fit(toBlob(cut), 1900000, { maxEdge: 2000 });
        const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
        fresh = `${uid}/c_${safeKey(s.id)}_${Date.now().toString(36)}.${ext}`;
        await upload("cuts", fresh, blob, false);
        Cache.put("cuts", fresh, cut);
        oldPath = path; path = fresh;
      }
      const { error } = await sb.from("stamps").upsert({ user_id: uid, id: s.id, data: body, cut_path: path });
      if (error) { if (fresh) removeFiles("cuts", [fresh]); fail(error); }
      if (changed) { cutFailed.delete(s.id); cutState.set(s.id, { path, url: cut }); }
      else if (!prev) cutState.set(s.id, { path, url: cut });
      if (oldPath && oldPath !== path) { removeFiles("cuts", [oldPath]); Cache.del("cuts", oldPath); }
    },
    async removeStamp(s) {
      const { error } = await sb.from("stamps").delete().eq("user_id", uid).eq("id", s.id);
      if (error) fail(error);
      const st = cutState.get(s.id); cutState.delete(s.id);
      if (st && st.path) { removeFiles("cuts", [st.path]); Cache.del("cuts", st.path); }
      const keys = ["ph_" + s.id, "sh_" + s.id, s.id, ...(s.scenes || []).map((k) => "sc_" + s.id + "_" + k)];
      removeFiles("photos", keys.map((k) => `${uid}/${safeKey(k)}`));
    },
    async putPhoto(key, url) {
      const blob = await fit(toBlob(url), 4800000, { maxEdge: 3000 });
      await upload("photos", `${uid}/${safeKey(key)}`, blob, true);
    },
    async getPhoto(key, legacy) {
      if (noNet()) return null;
      let b = await download("photos", `${uid}/${safeKey(key)}`);
      if (!b && legacy) b = await download("photos", `${uid}/${safeKey(legacy)}`);
      return b ? toDataUrl(b) : null;
    },
    async delPhoto(key) { await removeFiles("photos", [`${uid}/${safeKey(key)}`]); },
    async getMeta(key) {
      try {
        if (noNet()) throw new Error("offline");
        const { data } = await twice(() => sb.from("user_meta").select("data").eq("user_id", uid).eq("key", key).maybeSingle());
        const v = data ? data.data : null; snap.put("meta_" + key, v); return v;
      } catch (e) { if (netErr(e) || /timeout|abort/i.test(String(e && (e.message || e.name)))) offline = true; const old = await snap.get("meta_" + key); if (old === undefined || old === null) { if (offline) return null; throw e; } offline = true; return old; }
    },
    async putMeta(key, obj) {
      const body = this.clean({ ...obj, kind: key });
      const { error } = await sb.from("user_meta").upsert({ user_id: uid, key, data: body });
      if (error) fail(error); snap.put("meta_" + key, body);
    },

    /* community */
    async pubList() {
      const cached = (await Cache.get("kv", "shares")) || {};
      let idx;
      try { if (noNet()) throw new Error("offline"); const r = await twice(() => sb.from("shares").select("id,updated_at").order("updated_at", { ascending: false }).limit(1000)); idx = r.data; }
      catch (e) { if (!Object.keys(cached).length) throw e; idx = Object.values(cached).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map(r => ({ id: r.id, updated_at: r.updated_at })); }
      const need = idx.filter((r) => !cached[r.id] || cached[r.id].updated_at !== r.updated_at).map((r) => r.id);
      for (let i = 0; i < need.length; i += 80) {
        const { data, error: e2 } = await sb.from("shares").select("*").in("id", need.slice(i, i + 80));
        if (e2) fail(e2);
        data.forEach((r) => { cached[r.id] = r; });
      }
      const keep = {}; idx.forEach((r) => { if (cached[r.id]) keep[r.id] = cached[r.id]; });
      Cache.put("kv", "shares", keep);
      return idx.map((r) => keep[r.id]).filter(Boolean).map((r) => ({
        _id: r.id, sid: r.stamp_id, by: r.user_id, nick: r.nick, name: r.name, place: r.place, pref: r.pref, cat: r.cat,
        date: r.date, lat: r.lat, lng: r.lng, sizeMm: r.size_mm, thumb: r.thumb, rk: r.rk, spot: r.spot, spotTags: r.spot_tags || [],
        type: r.type, miss: r.kind === "miss", reason: r.reason, t: Date.parse(r.updated_at) || 0,
      }));
    },
    async pubPut(s, thumb, nick) {
      const { error } = await sb.from("shares").upsert(shareRow(s, thumb, nick), { onConflict: "user_id,stamp_id" });
      if (error) fail(error);
    },
    // many at once (used when the public settings change)
    async pubPutMany(items, nick) {
      const rows = items.map(({ s, thumb }) => shareRow(s, thumb, nick));
      for (let i = 0; i < rows.length; i += 10) { const { error } = await sb.from("shares").upsert(rows.slice(i, i + 10), { onConflict: "user_id,stamp_id" }); if (error) fail(error); }
    },
    async pubDelMany(ids) {
      for (let i = 0; i < ids.length; i += 100) { const { error } = await sb.from("shares").delete().eq("user_id", uid).eq("kind", "record").in("stamp_id", ids.slice(i, i + 100)); if (error) fail(error); }
    },

    /* everyone's public collections (server functions decide what can be seen) */
    async pubRanking() { const { data } = await ask(sb.rpc("public_ranking")); return data || []; },
    async pubCollection(u) { const { data } = await ask(sb.rpc("public_collection", { p_user: u })); return data || []; },
    async pubBooks(u) { const { data } = await ask(sb.rpc("public_books", { p_user: u })); return (data && Array.isArray(data.books)) ? data.books : []; },
    async cutOf(path) { return cutFor(path); },
    async photoOf(u, key) { if (noNet()) return null; const b = await download("photos", `${u}/${safeKey(key)}`); return b ? toDataUrl(b) : null; },
    async pubReport(o) {
      const { error } = await sb.from("shares").insert({
        user_id: uid, stamp_id: null, kind: "miss", type: "report", nick: clip(typeof Profile !== "undefined" ? Profile.nick : "", 20),
        rk: clip(o.rk, 120), name: clip(o.name, 120), lat: num(o.lat), lng: num(o.lng),
        date: typeof todayStr === "function" ? todayStr() : new Date().toISOString().slice(0, 10), reason: clip(o.reason, 40), spot: clip(o.note, 120),
      });
      if (error) fail(error);
    },
    async pubDel(sid) { try { await sb.from("shares").delete().eq("user_id", uid).eq("stamp_id", sid); } catch {} },
  };

  function shareRow(s, thumb, nick) {
    return {
      user_id: uid, stamp_id: s.id, kind: "record", nick: clip(nick, 20), name: clip(s.name, 120), place: clip(s.place, 120),
      pref: clip(s.pref, 10), cat: clip(s.cat, 20), type: clip(s.type || "stamp", 20), date: clip(s.date, 10),
      lat: num(s.lat), lng: num(s.lng), size_mm: num(s.sizeMm),
      rk: s.type === "goshuin" ? "" : clip(typeof rallyKeyOf === "function" ? rallyKeyOf(s) : "", 120),
      spot: clip(s.spot, 120), spot_tags: (s.spotTags || []).slice(0, 12).map((t) => clip(t, 30)),
      thumb: thumb && thumb.length < 115000 ? thumb : "",
    };
  }

  /* ---------- ログインを切らさないための控え ----------
     ・ログインの情報は localStorage に入るが、iPhone では消えたり、書き込めなかったりすることがある
       （プライベートブラウズ・アプリの中のブラウザ・空き容量が少ないとき など）
     ・そこで IndexedDB にも控えを置き、localStorage から消えていたら控えから戻す
     ・ログイン直後に保存できていなければ、URL でログイン情報を渡して読み込み直す（その画面を閉じるまではログインしたまま使える） */
  const AUTH_BK = "auth-backup";
  async function backupSession(s) { if (s && s.access_token && s.refresh_token) await Cache.put("kv", AUTH_BK, { a: s.access_token, r: s.refresh_token, at: Date.now() }); }
  async function restoreSession() {
    const b = await Cache.get("kv", AUTH_BK); if (!b || !b.a || !b.r || !sb) return null;
    try {
      const r = await within(sb.auth.setSession({ access_token: b.a, refresh_token: b.r }), 8000);
      if (r && r.data && r.data.session) return r.data.session;
      if (r && r.error && !/fetch|network/i.test(String(r.error.message || ""))) await Cache.del("kv", AUTH_BK);   // 期限切れなど、もう使えない控え
    } catch {}
    return null;
  }
  async function reloadKeepingSession() {
    let s = null; try { const r = await within(sb.auth.getSession(), 4000); s = r.data && r.data.session; } catch {}
    if (s) await backupSession(s);
    if (s && s.access_token && s.refresh_token && !(storeOK() && ls.get("petalog-auth"))) {
      const h = `#access_token=${encodeURIComponent(s.access_token)}&refresh_token=${encodeURIComponent(s.refresh_token)}&expires_in=${s.expires_in || 3600}${s.expires_at ? "&expires_at=" + s.expires_at : ""}&token_type=bearer&pl_mem=1`;
      try { history.replaceState(null, "", location.pathname + location.search + h); } catch { location.hash = h.slice(1); }
    }
    location.reload();
  }

  /* ---------- AI through the server ---------- */
  async function token() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }
  async function callFn(name, body, signal) {
    const tok = await token(); if (!tok) throw { code: "login_required" };
    let r;
    try {
      r = await fetch(`${CFG.url}/functions/v1/${name}`, { method: "POST", signal, headers: { "content-type": "application/json", apikey: CFG.key, Authorization: "Bearer " + tok }, body: JSON.stringify(body) });
    } catch { throw { code: signal && signal.aborted ? "cancelled" : "network" }; }
    let j = {}; try { j = await r.json(); } catch {}
    if (r.ok && j.ok) return j;
    const e = j.error;
    throw {
      code: e === "login_required" ? "login_required" : e === "user_limit" ? "user_limit" : e === "global_limit" ? "global_limit" : e === "month_limit" ? "month_limit"
        : e === "not_configured" || e === "bad_key" ? "not_configured" : e === "busy" ? "rate_limited" : "error",
      limit: j.limit,
    };
  }
  async function prepImage(b, edge) {
    // AIに送る前に小さくする（費用と通信量の節約）。透明部分は白にする。
    try { return await fit(b, 400000, { maxEdge: edge || 768, flatten: true, force: true }); } catch { return b; }
  }

  /* ---------- sheets ---------- */
  const H = (s) => (typeof esc === "function" ? esc(s) : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const say = (m, t) => (typeof toast === "function" ? toast(m, t) : alert(m));
  function authError(e) {
    const m = String((e && (e.message || e.msg || e.error_description)) || "").toLowerCase();
    const code = String((e && e.code) || "");
    if (/invalid login|invalid_credentials/.test(m + code)) return "メールアドレスかパスワードが違います。";
    if (/already registered|already exists|user_already_exists/.test(m + code)) return "このメールアドレスはもう登録されています。「ログイン」から入ってください。";
    if (/not confirmed|email_not_confirmed/.test(m + code)) return "確認メールのリンクを開いてから、ログインしてください。";
    if (/password/.test(m) && /(weak|short|least|characters)/.test(m)) return "パスワードは8文字以上にしてください（英字と数字をまぜると安心です）。";
    if (/rate|too many|security purposes/.test(m + code)) return "続けて試しすぎました。少し待ってからもう一度どうぞ。";
    if (/invalid.*email|email.*invalid|validation_failed/.test(m + code)) return "メールアドレスの形が正しくないようです。";
    if (/signups? not allowed|signup_disabled/.test(m + code)) return "いまは新しい登録を受け付けていません。";
    if (/fetch|network|failed to/.test(m)) return "通信できませんでした。電波を確かめてもう一度どうぞ。";
    const d = String((e && (e.name || e.code)) || "").slice(0, 40);
    return "うまくいきませんでした。もう一度どうぞ。" + (d ? `（${d}）` : "");
  }

  function openLogin(welcome) {
    if (typeof openSheet !== "function") return;
    if (!sb) { say("いまはログインの仕組みに接続できません。時間をおいて開き直してください。", 4000); return; }
    sheetCtx = { mode: "login" };
    let mode = "in";
    openSheet(`<div class="sheet-head"><h2>${welcome ? "ようこそ、ぺたろぐへ" : "ログイン"}</h2><button class="btn small ghost" type="button" data-close>閉じる</button></div>
      ${welcome ? `<p class="cap" style="margin-top:0">押した記念スタンプを写真から切り抜いて、トレカ・スタンプ帳・地図で集めるアプリです。</p>` : ""}
      <div class="sec">
        <div class="seg" role="group" aria-label="ログインか登録か"><button type="button" data-am="in" aria-pressed="true">ログイン</button><button type="button" data-am="up" aria-pressed="false">はじめての方（登録）</button></div>
        <form id="auForm" style="display:grid;gap:8px;margin-top:12px" novalidate>
          <input id="auEmail" class="search" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="メールアドレス" required>
          <div class="row2" style="display:flex;gap:6px"><input id="auPass" class="search" type="password" autocomplete="current-password" placeholder="パスワード（8文字以上）" minlength="8" required><button class="btn small" type="button" id="auShow" aria-pressed="false">表示</button></div>
          <button class="btn primary" type="submit" id="auGo">ログイン</button>
        </form>
        <p class="cap" id="auMsg" role="status" style="min-height:1.2em"></p>
        <p class="cap">ログインすると、記録があなたのアカウントに保存されます。スマホを替えても、PCからでも同じ記録が見られ、みんなの地図とAI推定も使えます。</p>
        <button class="btn small ghost" type="button" id="auForgot" style="margin-top:6px">パスワードを忘れたとき</button>
      </div>
      <div class="sec"><button class="btn ghost" type="button" id="auSkip" style="width:100%">ログインしないで使う（この端末だけに保存）</button></div>`);
    ss.set(SS_ASKED, "1");
    const setMode = (m) => {
      mode = m;
      document.querySelectorAll("[data-am]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.am === m)));
      $("#auGo").textContent = m === "in" ? "ログイン" : "登録してはじめる";
      $("#auPass").autocomplete = m === "in" ? "current-password" : "new-password";
      $("#auForgot").hidden = m !== "in";
      $("#auMsg").textContent = "";
    };
    document.querySelectorAll("[data-am]").forEach((b) => (b.onclick = () => setMode(b.dataset.am)));
    $("#auShow").onclick = () => { const p = $("#auPass"); const on = p.type === "password"; p.type = on ? "text" : "password"; $("#auShow").setAttribute("aria-pressed", String(on)); $("#auShow").textContent = on ? "隠す" : "表示"; };
    $("#auSkip").onclick = () => { ls.set(LS_SKIP, "1"); closeSheet(); say("この端末だけに保存します。あとから右上の設定でログインできます", 3600); };
    $("#auForgot").onclick = async () => {
      const email = $("#auEmail").value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("#auMsg").textContent = "上の欄にメールアドレスを入れてから押してください。"; return; }
      $("#auForgot").disabled = true;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      $("#auForgot").disabled = false;
      $("#auMsg").textContent = error ? "いまはメールを送れませんでした。時間をおいて試してください。" : "パスワードを決め直すためのメールを送りました。メールのリンクを開いてください。";
    };
    $("#auForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const email = $("#auEmail").value.trim(), password = $("#auPass").value;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("#auMsg").textContent = "メールアドレスの形が正しくないようです。"; return; }
      if (password.length < 8) { $("#auMsg").textContent = "パスワードは8文字以上にしてください。"; return; }
      const go = $("#auGo"); go.disabled = true; go.innerHTML = `<span class="spin"></span> ${mode === "in" ? "ログイン中" : "登録中"}`;
      try {
        if (mode === "in") {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        } else {
          const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw { message: "already registered" };
          if (!data.session) { $("#auMsg").textContent = "確認メールを送りました。メールのリンクを開いてから、ここでログインしてください。"; setMode("in"); $("#auEmail").value = email; return; }
        }
        ls.set(LS_SKIP, "");
        $("#auMsg").textContent = "ログインしました。読み込み直します…";
        setTimeout(() => { reloadKeepingSession(); }, 300);
      } catch (e) {
        $("#auMsg").textContent = authError(e);
      } finally { go.disabled = false; go.textContent = mode === "in" ? "ログイン" : "登録してはじめる"; }
    };
  }

  function openNewPassword() {
    if (typeof openSheet !== "function") return;
    sheetCtx = { mode: "newpass" };
    openSheet(`<div class="sheet-head"><h2>新しいパスワード</h2><button class="btn small ghost" type="button" data-close>閉じる</button></div>
      <div class="sec"><form id="npForm" style="display:grid;gap:8px" novalidate>
        <input id="npPass" class="search" type="password" autocomplete="new-password" placeholder="新しいパスワード（8文字以上）" minlength="8" required>
        <button class="btn primary" type="submit" id="npGo">このパスワードにする</button></form><p class="cap" id="npMsg" role="status"></p></div>`);
    $("#npForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const p = $("#npPass").value; if (p.length < 8) { $("#npMsg").textContent = "8文字以上にしてください。"; return; }
      $("#npGo").disabled = true;
      const { error } = await sb.auth.updateUser({ password: p });
      $("#npGo").disabled = false;
      if (error) { $("#npMsg").textContent = authError(error); return; }
      recovery = false; closeSheet(); say("パスワードを変えました");
    };
  }

  function openDelete() {
    sheetCtx = { mode: "delacct" };
    openSheet(`<div class="sheet-head"><h2>アカウントを削除</h2><button class="btn small ghost" type="button" data-close>やめる</button></div>
      <div class="sec"><p class="cap" style="margin-top:0">このアカウントの<b>すべての記録・写真・みんなの地図への投稿</b>を消して、ログインもできなくします。<b>元には戻せません。</b><br>残したい記録があれば、先に設定の「ファイルに書き出す」で保存してください。</p>
      <p class="cap">よければ、下の欄に「削除」と入れてください。</p>
      <div class="row2" style="display:flex;gap:6px;margin-top:8px"><input id="dlIn" class="search" placeholder="削除" autocomplete="off"><button class="btn small shu" type="button" id="dlGo" disabled>削除する</button></div>
      <p class="cap" id="dlMsg" role="status"></p></div>`);
    $("#dlIn").oninput = () => { $("#dlGo").disabled = $("#dlIn").value.trim() !== "削除"; };
    $("#dlGo").onclick = async () => {
      const b = $("#dlGo"); b.disabled = true; b.innerHTML = `<span class="spin"></span> 削除中`;
      try {
        await callFn("account", { action: "delete", confirm: "削除" });
        await sb.auth.signOut({ scope: "local" }).catch(() => {});
        await Cache.wipe();
        $("#dlMsg").textContent = "削除しました。";
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        b.disabled = false; b.textContent = "削除する";
        $("#dlMsg").textContent = e && e.code === "network" ? "通信できませんでした。もう一度どうぞ。" : "削除できませんでした。時間をおいてもう一度どうぞ。";
      }
    };
  }

  /* ---------- moving records saved on this device (before login) into the account ---------- */
  function localDb() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open("petalog", 1);
        r.onupgradeneeded = () => { const d = r.result; ["stamps", "photos", "meta"].forEach((n) => d.objectStoreNames.contains(n) || d.createObjectStore(n)); };
        r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
      } catch { res(null); }
    });
  }
  function idb(db, store, mode, fn) {
    return new Promise((res) => { try { const tx = db.transaction(store, mode); const q = fn(tx.objectStore(store)); tx.oncomplete = () => res(q && q.result); tx.onerror = () => res(null); } catch { res(null); } });
  }
  async function localCount() {
    const db = await localDb(); if (!db) return 0;
    const n = (await idb(db, "stamps", "readonly", (s) => s.count())) || 0; db.close(); return n;
  }
  async function moveLocal(btn) {
    const db = await localDb(); if (!db) return;
    const list = (await idb(db, "stamps", "readonly", (s) => s.getAll())) || [];
    const have = new Set((typeof stamps !== "undefined" ? stamps : []).map((s) => s.id));
    let n = 0, bad = 0;
    for (const s of list) {
      if (!s || !s.id) continue;
      if (btn) btn.innerHTML = `<span class="spin"></span> ${n + bad + 1}/${list.length}`;
      if (have.has(s.id)) { n++; continue; }
      try {
        await Store.saveStamp(s);
        const ph = (await idb(db, "photos", "readonly", (st) => st.get("ph_" + s.id))) || (await idb(db, "photos", "readonly", (st) => st.get(s.id)));
        if (ph) await Store.putPhoto("ph_" + s.id, ph);
        for (const k of s.scenes || []) { const u = await idb(db, "photos", "readonly", (st) => st.get("sc_" + s.id + "_" + k)); if (u) await Store.putPhoto("sc_" + s.id + "_" + k, u); }
        n++;
      } catch (e) { console.warn("move", e); bad++; }
    }
    try {
      const p = await idb(db, "meta", "readonly", (st) => st.get("profile"));
      if (p && typeof Profile !== "undefined") {
        (p.events || []).forEach((e) => Profile.events.includes(e) || Profile.events.push(e));
        (p.refs || []).forEach((r) => Profile.refs.some((x) => x.n === r.n) || Profile.refs.push(r));
        if (!Profile.nick && p.nick) Profile.nick = p.nick;
        await Profile.save();
      }
      const bd = await idb(db, "meta", "readonly", (st) => st.get("board"));
      if (bd && Array.isArray(bd.items) && bd.items.length && !(await Store.getMeta("board"))) await Store.putMeta("board", bd);
    } catch {}
    if (!bad) { await idb(db, "stamps", "readwrite", (st) => st.clear()); await idb(db, "photos", "readwrite", (st) => st.clear()); await idb(db, "meta", "readwrite", (st) => st.clear()); }
    db.close();
    return { n, bad };
  }
  async function offerMove() {
    const k = "petalog.moveAsked." + uid;
    if (ss.get(k)) return;
    const n = await localCount(); if (!n) return;
    ss.set(k, "1");
    sheetCtx = { mode: "move" };
    openSheet(`<div class="sheet-head"><h2>この端末の記録</h2><button class="btn small ghost" type="button" data-close>今はしない</button></div>
      <div class="sec"><p class="cap" style="margin-top:0">ログインする前にこの端末へ保存した記録が <b>${n} まい</b> あります。アカウントに移しますか？<br>移すと、ほかのスマホやPCからも見られるようになります。</p>
      <button class="btn primary" type="button" id="mvGo" style="width:100%;margin-top:10px">アカウントに移す</button><p class="cap" id="mvMsg" role="status"></p></div>`);
    $("#mvGo").onclick = async () => {
      const b = $("#mvGo"); b.disabled = true;
      const r = await moveLocal(b);
      if (!r) { $("#mvMsg").textContent = "読み込めませんでした。"; b.disabled = false; b.textContent = "アカウントに移す"; return; }
      $("#mvMsg").textContent = r.bad ? `${r.n} まい移しました。${r.bad} まいは移せませんでした（あとで設定からもう一度できます）。` : `${r.n} まい移しました。読み込み直します…`;
      if (!r.bad) setTimeout(() => location.reload(), 700); else { b.disabled = false; b.textContent = "もう一度試す"; }
    };
  }

  /* ---------- public API used by the app ---------- */
  window.PetalogCloud = {
    async attach(store) {
      if (!sb) return false;
      let session = null, err = null;
      try { const r = await within(sb.auth.getSession(), 6000); session = r.data && r.data.session; err = r.error; } catch (e) { err = e; }
      if ((!session || !session.user) && !err && navigator.onLine !== false && !ls.get(LS_SKIP)) { const b = await restoreSession(); if (b && b.user) session = b; }
      if (!session || !session.user) {
        // no connection: keep showing the signed-in user's last saved records instead of an empty app
        let saved = null; try { const j = JSON.parse(ls.get("petalog-auth") || "null"); saved = j && (j.user || (j.currentSession && j.currentSession.user)); } catch {}
        if (!(saved && saved.id && (err || !navigator.onLine))) return false;
        session = { user: saved }; offline = true;
      }
      user = session.user; uid = user.id; attached = true;
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch {}   // 端末の空きが少ないときも、ぺたろぐのデータを消さないでとお願いする
      Object.assign(store, methods, { uid, mode: "cloud", pub: true, col: null });
      return true;
    },
    loggedIn() { return attached; },
    isOffline() { return offline || noNet(); },
    email() { return user ? user.email : ""; },
    aiAvailable() { return attached; },
    async ai(task, args, images, signal) {
      if (!attached) throw { code: "login_required" };
      const imgs = [];
      // smaller pictures = fewer tokens = cheaper: the stamp at 768px, the whole photo at 512px
      for (const [i, b] of (images || []).entries()) { const p = await prepImage(b, i === 0 ? 768 : 512); imgs.push({ type: p.type || "image/jpeg", data: await toB64(p) }); }
      const j = await callFn("ai", { task, args, images: imgs }, signal);
      return j.result;
    },
    settingsHTML() {
      if (!sb) return `<div class="sec"><h4>アカウント</h4><p class="cap">いまはログインの仕組みに接続できません。時間をおいて開き直してください。</p></div>`;
      if (!attached) return `<div class="sec"><h4>アカウント</h4><p class="cap" style="margin-top:0">いまは記録がこの端末の中だけに保存されています。ログインすると、アカウントに保存されて機種変更しても消えず、みんなの地図とAI推定も使えます。</p>
        <button class="btn small primary" type="button" id="acIn" style="margin-top:8px">ログイン / 新規登録</button></div>`;
      return `<div class="sec"><h4>アカウント</h4><p class="cap" style="margin-top:0">ログイン中：<b>${H(user.email || "")}</b><br>記録はこのアカウントに保存されています。ほかのスマホやPCでも、同じメールアドレスでログインすれば見られます。</p>
        <p class="cap" id="acAi"></p><div id="acMove"></div>
        <div class="row2" style="margin-top:8px"><button class="btn small" type="button" id="acOut">ログアウト</button><button class="btn small ghost" type="button" id="acDel">アカウントを削除…</button></div></div>`;
    },
    wireSettings() {
      const i = $("#acIn"); if (i) i.onclick = () => openLogin(false);
      const o = $("#acOut"); if (o) o.onclick = async () => {
        o.disabled = true; await Cache.del("kv", AUTH_BK);
        await sb.auth.signOut().catch(() => {});
        await Cache.wipe();
        location.reload();
      };
      const d = $("#acDel"); if (d) d.onclick = openDelete;
      const a = $("#acAi");
      if (a && attached) callFn("ai", { task: "status" }).then((j) => {
        if (!$("#acAi")) return;
        $("#acAi").textContent = j.ready ? `AI推定：今日 ${j.used} / ${j.limit} 回${j.month_limit ? `（今月のアプリ全体 ${j.month_used} / ${j.month_limit} 回）` : ""}` : "AI推定：準備中";
      }).catch(() => {});
      if ($("#acMove") && attached) localCount().then((n) => {
        const box = $("#acMove"); if (!box || !n) return;
        box.innerHTML = `<p class="cap">この端末に、ログイン前の記録が ${n} まい残っています。</p><button class="btn small" type="button" id="acMv">アカウントに移す</button>`;
        $("#acMv").onclick = async () => { const b = $("#acMv"); b.disabled = true; const r = await moveLocal(b); say(r && !r.bad ? `${r.n} まい移しました` : "一部移せませんでした。もう一度どうぞ"); if (r && !r.bad) setTimeout(() => location.reload(), 600); else { b.disabled = false; b.textContent = "アカウントに移す"; } };
      });
    },
    afterBoot() {
      if (offline) { say("電波かサーバーにつながらないので、前回の記録を表示しています。いまは保存できません。", 6000); return; }
      if (recovery && attached) { openNewPassword(); return; }
      if (attached && (memLogin || !storeOK())) setTimeout(() => say("この画面ではログインを覚えておけないので、閉じるとログアウトします。Safariで開くか、ホーム画面のぺたろぐのアイコンから使ってください。", 9000), 3000);
      if (attached) { offerMove(); return; }
      if (!ls.get(LS_SKIP) && !ss.get(SS_ASKED)) openLogin(true);
    },
    openLogin,
  };

  // app shell stays on the phone: opens even when the network or GitHub is unreachable
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").then(reg => {
      // アプリに戻ってきたら新しい版がないか確認
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    }).catch(() => {}));
    // 新しい版に切り替わったら自動で読み込み直す（記録の入力中は閉じるまで待つ）
    // ログインの更新（トークンの入れ替え）の途中で読み込み直すとログアウトになることがあるので、終わるのを待ってから
    let had = !!navigator.serviceWorker.controller, waiting = false, going = false;
    const busy = () => { const w = document.getElementById("sheetWrap"); return (w && !w.hidden) || !!document.querySelector(".pview:not([hidden])") || document.visibilityState !== "visible"; };
    const reload = async () => { if (going) return; going = true; if (sb) { try { await within(sb.auth.getSession(), 5000); } catch {} } await new Promise(r => setTimeout(r, 800)); location.reload(); };
    const go = () => { if (busy()) { if (!waiting) { waiting = true; setInterval(() => { if (!busy()) reload(); }, 1500); } return; } reload(); };
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!had) { had = true; return; } setTimeout(go, 1500); });
  }
  addEventListener("online", () => { if (offline) { say("つながりました。読み込み直します"); setTimeout(() => location.reload(), 1200); } });
  if (sb) {
    sb.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session) setTimeout(() => { backupSession(session); }, 0);
      if (event === "PASSWORD_RECOVERY") { recovery = true; if (typeof ready !== "undefined" && ready) openNewPassword(); }
      if (event === "SIGNED_OUT" && attached && !offline) setTimeout(() => location.reload(), 200);
    });
  }
})();
