/* Aysu üçün sirr — front + back BİR FAYLDA
 * Asılılıq yoxdur, yalnız Node.js 18+ lazımdır.
 *
 * VS Code-da aç -> Terminal -> node app.js -> brauzerdə http://localhost:3000
 * Dəvətnaməni doldurmaq üçün: http://localhost:3000/?admin=ADMIN_PAROLUN
 *
 * Aşağıdakı ADMIN_PAROL-u öz parolunla dəyiş.
 *
 * API:
 *   GET  /api/invite            -> dəvətnamə sahələri (hamı oxuya bilər)
 *   PUT  /api/invite            -> sahələri yenilə (admin token lazımdır)
 *   POST /api/events            -> {type:"yes"|"no_escape"|"open", ...} hadisə yaz
 *   GET  /api/events            -> hadisələrin siyahısı + xülasə (admin)
 *   GET  /api/health            -> yoxlama
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_PAROL = "aysu123"; // <-- BUNU DƏYİŞ
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ADMIN_PAROL;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
// İstəyə bağlı Telegram bildirişi (Aysu "Həə" basanda sənə mesaj gəlir)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";


/* ---------- sadə JSON verilənlər bazası ---------- */
const FIELDS = ["day", "time", "place", "gift"];
const MAX_LEN = 90;
let db = { invite: { day: "", time: "", place: "", gift: "" }, events: [] };

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.invite = Object.assign(db.invite, raw.invite || {});
    db.events = Array.isArray(raw.events) ? raw.events : [];
  } catch (e) { /* ilk işə salma */ }
}
let writing = false, dirty = false;
function save() {
  if (writing) { dirty = true; return; }
  writing = true;
  const tmp = DB_FILE + ".tmp";
  fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
    if (!err) fs.rename(tmp, DB_FILE, () => done());
    else done();
  });
  function done() { writing = false; if (dirty) { dirty = false; save(); } }
}
load();

/* ---------- köməkçilər ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}
function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(Object.assign(new Error("bad json"), { code: 400 })); }
    });
    req.on("error", reject);
  });
}
function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const h = req.headers["authorization"] || "";
  const given = h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-admin-token"] || "");
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
const hits = new Map(); // sadə rate limit: IP başına dəqiqədə 120 sorğu
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter((t) => now - t < 60000); recent.push(now); hits.set(ip, recent);
  return recent.length > 120;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some((t) => n - t < 60000)) hits.delete(k); }, 60000).unref();

function clean(s) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
}
function notify(text) {
  if (!TG_TOKEN || !TG_CHAT || typeof fetch !== "function") return;
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  }).catch(() => {});
}
function summary() {
  const ev = db.events;
  const yes = ev.filter((e) => e.type === "yes");
  const escapes = ev.filter((e) => e.type === "no_escape").length;
  return {
    opened: ev.filter((e) => e.type === "open").length,
    said_yes: yes.length > 0,
    first_yes_at: yes.length ? yes[0].at : null,
    no_escapes_total: escapes,
    last_event_at: ev.length ? ev[ev.length - 1].at : null,
  };
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const ip = req.socket.remoteAddress || "?";
  if (limited(ip)) return json(res, 429, { error: "Çox sorğu" });

  if (url.pathname === "/api/health") return json(res, 200, { ok: true });

  if (url.pathname === "/api/invite") {
    if (req.method === "GET") return json(res, 200, { invite: db.invite });
    if (req.method === "PUT") {
      if (!isAdmin(req)) return json(res, 401, { error: "İcazə yoxdur" });
      const body = await readBody(req);
      for (const k of FIELDS) if (k in body) db.invite[k] = clean(body[k]);
      save();
      return json(res, 200, { invite: db.invite });
    }
    return json(res, 405, { error: "Metod dəstəklənmir" });
  }

  if (url.pathname === "/api/events") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const type = ["open", "yes", "no_escape"].includes(body.type) ? body.type : null;
      if (!type) return json(res, 400, { error: "Yanlış hadisə növü" });
      const ev = { type, at: new Date().toISOString() };
      if (type === "no_escape") ev.count = Math.max(1, Math.min(999, parseInt(body.count, 10) || 1));
      if (type === "yes") ev.no_escapes_before = Math.max(0, Math.min(999, parseInt(body.escapes, 10) || 0));
      // eyni hadisənin təkrar yazılmasının qarşısı (yes və open yalnız ilk dəfə)
      if ((type === "yes" || type === "open") && db.events.some((e) => e.type === type)) {
        return json(res, 200, { ok: true, duplicate: true });
      }
      db.events.push(ev);
      if (db.events.length > 5000) db.events.splice(0, db.events.length - 5000);
      save();
      if (type === "yes") notify(`❤️ Aysu "Həə" dedi! (Yox düyməsini ${ev.no_escapes_before} dəfə qovdu 😂)`);
      return json(res, 201, { ok: true });
    }
    if (req.method === "GET") {
      if (!isAdmin(req)) return json(res, 401, { error: "İcazə yoxdur" });
      return json(res, 200, { summary: summary(), events: db.events.slice(-200) });
    }
    return json(res, 405, { error: "Metod dəstəklənmir" });
  }

  return json(res, 404, { error: "Tapılmadı" });
}

/* ---------- səhifə (front) ---------- */
function servePage(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(req.method === "HEAD" ? undefined : PAGE);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    if (url.pathname === "/" || url.pathname === "/index.html") return servePage(req, res);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Tapılmadı");
  } catch (e) {
    json(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.message || "Server xətası" });
  }
});
server.listen(PORT, () => {
  console.log(`❤️  Aysu üçün: http://localhost:${PORT}`);
  console.log(`🔑 Sənin admin linkin: http://localhost:${PORT}/?admin=${ADMIN_TOKEN}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));

/* ====================================================================
 *  FRONT — səhifənin özü (HTML/CSS/JS). Dizaynı dəyişmək istəsən buranı redaktə et.
 * ==================================================================== */
const PAGE = String.raw`<title>Aysu üçün sirr</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,400;1,500;1,600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* Layout: one fixed stage, five full-screen scenes cross-fading. A fixed floating layer holds the escaping "Yox" button outside any transformed scene so it can roam the real viewport. */
:root{
  --night:#080519; --navy:#0e1a4a; --plum:#2b1160;
  --rose:#ff5c9d; --blush:#ffb3d0; --gold:#f3d9a4; --lav:#c9b6ff;
  --ink:#fff6fb; --soft:rgba(255,246,251,.8);
  --glass:rgba(255,255,255,.07); --glass-b:rgba(255,255,255,.17);
  --display:"Cormorant Garamond","Iowan Old Style",Georgia,serif;
  --body:"Manrope",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden;overscroll-behavior:none}
body{
  background:linear-gradient(180deg,#0a0626 0%,#0b1240 58%,#1c0f3f 100%);
  color:var(--ink); font-family:var(--body); -webkit-font-smoothing:antialiased;
  -webkit-text-size-adjust:100%; touch-action:manipulation;
  padding-left:max(0px,env(safe-area-inset-left,0px)); padding-right:max(0px,env(safe-area-inset-right,0px));
}
button{font-family:inherit}
.aurora{position:fixed;inset:-20%;z-index:0;pointer-events:none;
  background:
   radial-gradient(40% 35% at 20% 20%,rgba(104,56,206,.55),transparent 70%),
   radial-gradient(45% 40% at 85% 75%,rgba(255,92,157,.26),transparent 70%),
   radial-gradient(50% 45% at 50% 105%,rgba(30,64,170,.55),transparent 70%);
  animation:drift 26s ease-in-out infinite alternate}
@keyframes drift{from{transform:translate3d(-3%,-2%,0) scale(1)}to{transform:translate3d(3%,2%,0) scale(1.12)}}
canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
#bg{z-index:1}
#fx{z-index:50}
.moon{position:fixed;z-index:2;pointer-events:none;top:calc(env(safe-area-inset-top,0px) + 5vh);right:9vw;
  width:clamp(64px,17vw,112px);aspect-ratio:1;border-radius:50%;
  background:radial-gradient(circle at 34% 32%,#fffdf4 0%,#f8ebc8 48%,#d4bf90 100%);
  box-shadow:0 0 50px 14px rgba(243,217,164,.35),0 0 170px 70px rgba(201,182,255,.2);
  transition:opacity 1.6s,transform 1.6s;animation:moonFloat 9s ease-in-out infinite alternate}
.moon::before,.moon::after{content:"";position:absolute;border-radius:50%;background:rgba(160,135,90,.22)}
.moon::before{width:22%;height:22%;left:52%;top:24%}
.moon::after{width:14%;height:14%;left:26%;top:56%}
@keyframes moonFloat{from{transform:translateY(0)}to{transform:translateY(8px)}}
body:not([data-scene="1"]) .moon{opacity:.32;transform:scale(.7)}
.grain{position:fixed;inset:0;z-index:3;pointer-events:none;opacity:.08;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
.vignette{position:fixed;inset:0;z-index:3;pointer-events:none;background:radial-gradient(120% 90% at 50% 45%,transparent 55%,rgba(4,2,16,.7) 100%)}

/* scenes */
.scene{position:fixed;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;
  padding:calc(env(safe-area-inset-top,0px) + 22px) max(16px,env(safe-area-inset-left,0px)) calc(env(safe-area-inset-bottom,0px) + 22px) max(16px,env(safe-area-inset-right,0px));
  overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;
  opacity:0;visibility:hidden;pointer-events:none;transform:scale(.965);filter:blur(10px);
  transition:opacity .8s ease,transform .9s ease,filter .8s ease,visibility 0s linear .9s}
.scene.active{opacity:1;visibility:visible;pointer-events:auto;transform:none;filter:none;
  transition:opacity 1s ease .45s,transform 1.1s ease .45s,filter 1s ease .45s,visibility 0s}
#s4{transform:scale(1.4)}
#s4.active{transition-duration:1.4s,2.6s,1.2s,0s}
.stack{margin:auto;width:100%;max-width:460px;display:flex;flex-direction:column;align-items:center;text-align:center;min-width:0}

.btn{appearance:none;border:0;position:relative;overflow:hidden;min-height:56px;padding:0 32px;border-radius:999px;
  font:700 17px/1 var(--body);letter-spacing:.01em;color:#2b0f3d;cursor:pointer;
  background:linear-gradient(135deg,#fff0d2,#f3d9a4 45%,#ffb3d0);
  box-shadow:0 12px 40px -10px rgba(255,92,157,.7),0 0 0 1px rgba(255,255,255,.35) inset;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  transition:transform .2s,opacity .9s,visibility .9s}
.btn::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.7) 50%,transparent 70%);transform:translateX(-120%);animation:shine 3.6s ease-in-out infinite}
@keyframes shine{0%,55%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
.btn:active{transform:scale(.96)}
.btn:focus-visible,.yes:focus-visible,.no:focus-visible{outline:2px solid var(--lav);outline-offset:4px}
.btn.ghost{background:var(--glass);color:var(--ink);box-shadow:0 0 0 1px var(--glass-b) inset;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.btn.ghost::after{display:none}
.hide{opacity:0;visibility:hidden;pointer-events:none;transform:translateY(14px)}

/* word reveals */
.w,.ch{display:inline-block}
.w{opacity:0;filter:blur(10px);transform:translateY(10px)}
.go .w{animation:wordIn 1s cubic-bezier(.2,.7,.2,1) forwards;animation-delay:var(--d)}
@keyframes wordIn{to{opacity:1;filter:blur(0);transform:none}}
.line{opacity:0;transition:opacity .8s}
.line.go{opacity:1}
.scene.skip .w,.scene.skip .ch{opacity:1;filter:none;transform:none;animation:none}
.scene.skip .line{opacity:1;transition:none}
.ch{opacity:0;transform:translateY(30px) scale(.4)}
.go .ch{animation:pop .75s cubic-bezier(.2,1.6,.4,1) forwards;animation-delay:var(--d)}
@keyframes pop{to{opacity:1;transform:none}}
.wd{display:inline-block;white-space:nowrap}

/* scene 1 */
.env{position:relative;width:min(72vw,300px);aspect-ratio:1.5;margin:0 auto 38px;animation:float 5s ease-in-out infinite alternate;
  filter:drop-shadow(0 22px 46px rgba(255,92,157,.38));transition:transform 1.6s cubic-bezier(.6,0,.3,1),opacity 1.2s}
@keyframes float{from{transform:translateY(-6px) rotate(-1.2deg)}to{transform:translateY(8px) rotate(1.2deg)}}
.env.fly{animation:none;transform:scale(2.6) translateY(-6%);opacity:0}
.env>*{position:absolute}
.e-back{inset:0;border-radius:10px;background:linear-gradient(160deg,#5b2a8f,#3a1a6e 60%,#2a1259)}
.e-letter{left:7%;right:7%;top:9%;bottom:7%;border-radius:6px;z-index:1;background:linear-gradient(170deg,#fffaf0,#f6e2b8);
  display:grid;place-items:center;color:#8a3a62;font:italic 600 clamp(20px,6vw,26px)/1 var(--display);
  box-shadow:0 0 0 1px rgba(243,217,164,.6) inset;transition:transform 1.3s cubic-bezier(.3,.8,.25,1) .55s}
.e-front{inset:0;z-index:2;border-radius:10px;clip-path:polygon(0 0,50% 54%,100% 0,100% 100%,0 100%);
  background:linear-gradient(160deg,#7a3aa8,#4b2086 55%,#8f3d96)}
.e-flap{left:0;right:0;top:0;height:55%;z-index:3;transform-origin:50% 0;clip-path:polygon(0 0,100% 0,50% 100%);
  background:linear-gradient(180deg,#a45bc4,#6b2fa3);transition:transform .95s cubic-bezier(.5,0,.2,1),z-index 0s .45s}
.e-seal{left:50%;top:54%;z-index:4;width:15%;aspect-ratio:1;border-radius:50%;transform:translate(-50%,-50%);display:grid;place-items:center;
  background:radial-gradient(circle at 35% 30%,#ffd2e4,#ff5c9d 55%,#b3125a);color:#fff;font-size:clamp(12px,3.6vw,16px);
  box-shadow:0 4px 16px rgba(255,92,157,.7);transition:opacity .4s,transform .5s;animation:sealPulse 2.2s ease-in-out infinite}
@keyframes sealPulse{50%{box-shadow:0 4px 26px rgba(255,92,157,1)}}
.env.open .e-flap{transform:rotateX(180deg);z-index:0}
.env.open .e-letter{transform:translateY(-62%)}
.env.open .e-seal{opacity:0;transform:translate(-50%,-50%) scale(.2)}
.name{margin:0 0 12px;font:italic 500 clamp(54px,18vw,96px)/1 var(--display);letter-spacing:.01em;
  color:var(--gold);background:linear-gradient(100deg,#fff3d6,#f3d9a4 40%,#ffb3d0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  filter:drop-shadow(0 0 22px rgba(243,217,164,.4));opacity:0;transform:translateY(12px);transition:opacity 1.6s,transform 1.6s}
.name.go{opacity:1;transform:none}
.scene.skip .name{opacity:1;transform:none;transition:none}
.whisper{margin:0 0 30px;max-width:19em;font:400 clamp(18px,5.2vw,23px)/1.55 var(--body);color:var(--soft)}
#s1.opening .name,#s1.opening .whisper,#s1.opening #openBtn{opacity:0;transition:opacity .8s}

/* scene 2 + hearts */
.hstage{--hs:clamp(110px,22vh,170px);position:relative;width:var(--hs);height:var(--hs);perspective:700px;margin:0 auto 26px;flex:none}
.hstage .glow{position:absolute;inset:-60%;background:radial-gradient(circle,rgba(255,92,157,.55),rgba(255,92,157,.12) 40%,transparent 68%);animation:glowPulse 1.5s ease-in-out infinite}
@keyframes glowPulse{50%{transform:scale(1.18);opacity:.75}}
.beat{position:absolute;inset:0;transform-style:preserve-3d;animation:beat 1.5s ease-in-out infinite}
@keyframes beat{0%,100%{transform:scale(1)}14%{transform:scale(1.1)}28%{transform:scale(1)}42%{transform:scale(1.06)}}
.h3d{position:absolute;inset:0;transform-style:preserve-3d;animation:sway 5s ease-in-out infinite alternate}
@keyframes sway{from{transform:rotateX(-8deg) rotateY(-42deg)}to{transform:rotateX(8deg) rotateY(42deg)}}
.h3d svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.orbit{position:absolute;inset:-26%;animation:spin 9s linear infinite;pointer-events:none}
.orbit i{position:absolute;left:50%;top:0;font-style:normal;color:var(--gold);font-size:14px;text-shadow:0 0 10px var(--gold)}
.orbit i:nth-child(2){top:auto;bottom:0;color:var(--blush)}
.orbit i:nth-child(3){left:0;top:50%;color:var(--lav)}
@keyframes spin{to{transform:rotate(360deg)}}
.letter p{margin:0 0 20px;font:400 clamp(18px,5vw,23px)/1.55 var(--body);color:var(--soft);max-width:21em}
.letter p.em{font:italic 500 clamp(22px,6.4vw,30px)/1.3 var(--display);color:var(--gold);margin-bottom:28px}

/* scene 3 */
.qcard{padding:26px 22px 28px;border-radius:26px;background:linear-gradient(160deg,rgba(255,255,255,.11),rgba(255,255,255,.03));
  box-shadow:0 0 0 1px var(--glass-b) inset,0 30px 80px -30px rgba(255,92,157,.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);width:100%}
.qcard .mini{color:var(--rose);font-size:20px;margin-bottom:8px;filter:drop-shadow(0 0 8px var(--rose))}
.qcard h2{margin:0;font:italic 500 clamp(27px,8vw,40px)/1.18 var(--display);text-wrap:balance}
.msg{min-height:3.1em;margin:20px 0 22px;font:600 16px/1.4 var(--body);color:var(--gold);max-width:20em;display:flex;align-items:center;justify-content:center}
.msg.pop{animation:msgPop .5s cubic-bezier(.2,1.5,.4,1)}
@keyframes msgPop{from{transform:scale(.8);opacity:0}}
.yes{--ys:1;--yb:1;--yg:24px;appearance:none;border:0;cursor:pointer;min-height:62px;padding:0 36px;border-radius:999px;color:#fff;
  font:800 19px/1 var(--body);text-shadow:0 1px 8px rgba(120,0,60,.45);
  background:linear-gradient(135deg,#ff4f93,#ff86b6 55%,#ffc09f);touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  box-shadow:0 0 var(--yg) rgba(255,92,157,.85),0 0 0 2px rgba(255,255,255,.35) inset;
  transform:scale(var(--ys));filter:brightness(var(--yb)) saturate(1.1);
  transition:transform .7s cubic-bezier(.3,1.5,.5,1),filter .7s,box-shadow .7s;animation:yesBreath 2.2s ease-in-out infinite}
@keyframes yesBreath{50%{box-shadow:0 0 calc(var(--yg) * 1.8) rgba(255,92,157,1),0 0 0 2px rgba(255,255,255,.5) inset}}
.noSlot{height:54px;margin-top:20px;flex:none}
.layer{position:fixed;inset:0;z-index:30;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .8s .45s,visibility 0s .45s}
.layer.on{opacity:1;visibility:visible}
.layer:not(.on){transition:opacity .4s,visibility 0s .4s}
.no{position:absolute;left:0;top:0;pointer-events:auto;appearance:none;cursor:pointer;min-height:50px;padding:0 24px;border-radius:999px;white-space:nowrap;
  font:600 16px/1 var(--body);color:var(--ink);background:rgba(255,255,255,.1);box-shadow:0 0 0 1px var(--glass-b) inset;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);touch-action:none;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;
  transition:transform var(--td,.5s) cubic-bezier(.2,.9,.25,1);will-change:transform}
.no.snap{transition:none}
.sparks{position:fixed;inset:0;z-index:45;pointer-events:none;overflow:hidden}
.sparks span{position:absolute;font-size:19px;animation:fly 1.1s ease-out forwards}
@keyframes fly{0%{transform:translate(-50%,-50%) scale(.3);opacity:0}15%{opacity:1}100%{transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) scale(var(--s)) rotate(var(--rot));opacity:0}}

/* scene 4 */
.yay{margin:0 0 22px;font:800 clamp(30px,9.4vw,54px)/1.12 var(--body);letter-spacing:-.01em;color:#fff;
  text-shadow:0 0 26px rgba(255,92,157,.9),0 0 60px rgba(243,217,164,.5);text-wrap:balance}
#s4 .line{font:400 clamp(18px,5vw,23px)/1.5 var(--body);color:var(--soft);margin:0 0 16px;max-width:20em}
#s4 .line.last{font:italic 500 clamp(22px,6.2vw,30px)/1.3 var(--display);color:var(--gold);margin-bottom:30px}
#s4 .hstage{--hs:clamp(120px,24vh,190px)}
#s4.active .hstage{animation:heartIn 1.8s cubic-bezier(.2,1.3,.3,1) .5s both}
@keyframes heartIn{from{transform:scale(0) rotate(-40deg);opacity:0}}
.flash{position:fixed;inset:0;z-index:60;pointer-events:none;opacity:0;background:radial-gradient(circle,#fff,#ffd0e4 50%,#ff8fb8)}
.flash.go{animation:flash 1.1s ease-out}
@keyframes flash{0%{opacity:0}15%{opacity:.95}100%{opacity:0}}
.ring{position:fixed;left:50%;top:45%;z-index:49;width:30px;height:30px;margin:-15px;border-radius:50%;pointer-events:none;border:3px solid rgba(255,214,230,.9);box-shadow:0 0 40px rgba(255,92,157,.9),0 0 40px rgba(255,92,157,.9) inset;opacity:0}
.ring.go{animation:ring 1.4s ease-out}
@keyframes ring{0%{transform:scale(.2);opacity:1}100%{transform:scale(45);opacity:0}}

/* scene 5 */
.card{position:relative;width:100%;padding:34px 22px 28px;border-radius:30px;border:1px solid transparent;text-align:center;
  background:linear-gradient(165deg,rgba(40,18,90,.92),rgba(14,18,70,.92)) padding-box,linear-gradient(135deg,#f3d9a4,#ff7fb0 40%,#c9b6ff 70%,#f3d9a4) border-box;
  box-shadow:0 40px 100px -30px rgba(255,92,157,.55),0 0 60px -10px rgba(243,217,164,.25)}
.card::before{content:"";position:absolute;inset:8px;border-radius:23px;border:1px solid rgba(243,217,164,.28);pointer-events:none}
.orn{color:var(--gold);letter-spacing:.5em;font-size:13px;margin-bottom:10px;padding-left:.5em}
.kick{font:600 12px/1 var(--body);letter-spacing:.22em;color:var(--lav);margin-bottom:6px}
.who{margin:0 0 6px;font:italic 500 clamp(46px,15vw,68px)/1 var(--display);color:var(--gold)}
.sub{margin:0 0 24px;font:400 15px/1.5 var(--body);color:var(--soft)}
.fields{display:grid;gap:12px;text-align:left;margin-bottom:6px}
.field{padding:13px 16px 14px;border-radius:16px;background:rgba(255,255,255,.055);box-shadow:0 0 0 1px rgba(243,217,164,.2) inset;transition:box-shadow .3s,background .3s}
.field:focus-within{background:rgba(255,255,255,.1);box-shadow:0 0 0 1.5px var(--gold) inset,0 0 24px -4px rgba(243,217,164,.5)}
.flabel{font:700 11px/1 var(--body);letter-spacing:.2em;color:var(--gold);margin-bottom:8px;display:flex;justify-content:space-between;gap:8px}
.flabel b{font-weight:500;letter-spacing:.04em;color:rgba(201,182,255,.8);font-size:11px}
.fval{min-height:1.5em;font:500 19px/1.4 var(--body);color:var(--ink);outline:none;word-break:break-word;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text;caret-color:var(--rose)}
.fval:empty::before{content:attr(data-ph);font:italic 500 18px/1.4 var(--display);color:rgba(255,246,251,.62);pointer-events:none}
.save{min-height:1.4em;margin:8px 0 18px;font:500 12px/1.4 var(--body);color:var(--lav);opacity:0;transition:opacity .4s}
.save.on{opacity:1}
.rule{height:1px;margin:6px auto 20px;width:62%;background:linear-gradient(90deg,transparent,var(--gold),transparent)}
.close{margin:0 0 18px;font:italic 500 clamp(21px,5.8vw,26px)/1.4 var(--display);color:var(--ink);text-wrap:balance}
.sign{margin:0;font:italic 600 clamp(30px,9vw,40px)/1.1 var(--display);color:var(--gold);text-shadow:0 0 24px rgba(243,217,164,.4)}
.actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:22px}
.actions .btn{min-height:50px;padding:0 22px;font-size:15px}
.rv{opacity:0;transform:translateY(18px)}
.active .rv{animation:rise .9s cubic-bezier(.2,.7,.2,1) forwards;animation-delay:calc(var(--i,0) * .14s + .7s)}
@keyframes rise{to{opacity:1;transform:none}}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;transition-delay:0s!important}
  .w,.ch,.rv,.name{opacity:1!important;filter:none!important;transform:none!important}
  .scene,#s4{transform:none;filter:none}
  .h3d{transform:rotateX(-6deg) rotateY(-22deg)}
  .no{transition:none}
}
@media (max-height:620px){.stack .hstage{margin-bottom:14px}.env{margin-bottom:24px}}
</style>

<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <radialGradient id="hgF" cx="34%" cy="26%" r="85%"><stop offset="0" stop-color="#ffe0ec"/><stop offset=".3" stop-color="#ff6aa6"/><stop offset="1" stop-color="#b3125a"/></radialGradient>
</defs></svg>

<div class="aurora"></div>
<canvas id="bg"></canvas>
<div class="moon" aria-hidden="true"></div>
<div class="grain"></div>
<div class="vignette"></div>

<main>
<section class="scene" id="s1" aria-label="Sirr">
  <div class="stack">
    <div class="env" id="env" aria-hidden="true">
      <div class="e-back"></div>
      <div class="e-letter">Aysu ♡</div>
      <div class="e-front"></div>
      <div class="e-flap"></div>
      <div class="e-seal">♥</div>
    </div>
    <h1 class="name" id="s1name">Aysu...</h1>
    <p class="whisper line" id="s1line"></p>
    <button class="btn hide" id="openBtn" type="button">Sirri aç ✨</button>
  </div>
</section>

<section class="scene" id="s2" aria-label="Məktub">
  <div class="stack letter">
    <div class="hstage" id="heart2"></div>
    <p class="line" id="l1"></p>
    <p class="line" id="l2"></p>
    <p class="line em" id="l3"></p>
    <button class="btn hide" id="toQ" type="button">Davam et 🤍</button>
  </div>
</section>

<section class="scene" id="s3" aria-label="Sual">
  <div class="stack">
    <div class="qcard" id="qCard">
      <div class="mini" aria-hidden="true">♥</div>
      <h2>Aysu, mənimlə gözəl bir görüşə çıxarsan? 🥹❤️</h2>
    </div>
    <p class="msg" id="msg" aria-live="polite">Ürəyin nə deyir? 💭</p>
    <button class="yes" id="yes" type="button">Həə, əlbəttə! ❤️</button>
    <div class="noSlot" id="noSlot"></div>
  </div>
</section>

<section class="scene" id="s4" aria-label="Bəli">
  <div class="stack">
    <div class="hstage" id="heart4"></div>
    <h2 class="yay" id="yay"></h2>
    <p class="line" id="y1">Deməli, bu artıq sadəcə bir xəyal deyil...</p>
    <p class="line last" id="y2">Səninlə gözəl bir xatirə yaratmaq üçün səbirsizlənirəm, Aysu. 🥹</p>
    <button class="btn hide" id="toInvite" type="button">Dəvətnaməni aç 💌</button>
  </div>
</section>

<section class="scene" id="s5" aria-label="Dəvətnamə">
  <div class="stack">
    <article class="card">
      <div class="orn rv" style="--i:0" aria-hidden="true">✦ ✦ ✦</div>
      <div class="kick rv" style="--i:1">XÜSUSİ DƏVƏTNAMƏ</div>
      <h2 class="who rv" style="--i:2">Aysu</h2>
      <p class="sub rv" style="--i:3">Bu görüş yalnız sənin üçündür.</p>
      <div class="fields">
        <div class="field rv" style="--i:4"><div class="flabel"><span>GÖRÜŞ GÜNÜ</span><b>dəyişmək üçün toxun</b></div><div class="fval" contenteditable="true" role="textbox" aria-label="Görüş günü" data-key="day" data-ph="Bəzi sürprizlər əvvəlcədən bilinməməlidir... ❤️" spellcheck="false" enterkeyhint="done"></div></div>
        <div class="field rv" style="--i:5"><div class="flabel"><span>GÖRÜŞ SAATI</span><b>dəyişmək üçün toxun</b></div><div class="fval" contenteditable="true" role="textbox" aria-label="Görüş saatı" data-key="time" data-ph="Bəzi sürprizlər əvvəlcədən bilinməməlidir... ❤️" spellcheck="false" enterkeyhint="done"></div></div>
        <div class="field rv" style="--i:6"><div class="flabel"><span>GÖRÜŞ MƏKANI</span><b>dəyişmək üçün toxun</b></div><div class="fval" contenteditable="true" role="textbox" aria-label="Görüş məkanı" data-key="place" data-ph="Bəzi sürprizlər əvvəlcədən bilinməməlidir... ❤️" spellcheck="false" enterkeyhint="done"></div></div>
        <div class="field rv" style="--i:7"><div class="flabel"><span>KİÇİK SÜRPRİZ</span><b>dəyişmək üçün toxun</b></div><div class="fval" contenteditable="true" role="textbox" aria-label="Kiçik sürpriz" data-key="gift" data-ph="Bəzi sürprizlər əvvəlcədən bilinməməlidir... ❤️" spellcheck="false" enterkeyhint="done"></div></div>
      </div>
      <div class="save" id="saveNote" role="status">Yadda saxlanıldı ✓</div>
      <div class="rule rv" style="--i:8"></div>
      <p class="close rv" style="--i:9">Bu, sadəcə bir görüş deyil. Bəlkə də ən gözəl xatirələrimizdən birinin başlanğıcıdır.</p>
      <p class="sign rv" style="--i:10">Sevgilərlə ❤️</p>
      <div class="actions rv" style="--i:11">
        <button class="btn" id="copyBtn" type="button">Təfərrüatları kopyala</button>
        <button class="btn ghost" id="replayBtn" type="button">Yenidən izlə ↺</button>
      </div>
    </article>
  </div>
</section>
</main>

<div class="layer" id="floatLayer"><button class="no snap" id="no" type="button">Yox, istəmirəm 🙈</button></div>
<div class="sparks" id="sparks" aria-hidden="true"></div>
<canvas id="fx"></canvas>
<div class="ring" id="ring"></div>
<div class="flash" id="flash"></div>
<div id="probe" aria-hidden="true" style="position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)"></div>

<script>
(function(){
"use strict";
var $=function(s){return document.querySelector(s)}, $$=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
var RM=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
var LOW=(navigator.hardwareConcurrency||8)<=4;
var rand=function(a,b){return a+Math.random()*(b-a)};
var pick=function(a){return a[Math.floor(Math.random()*a.length)]};
var scenes=[$("#s1"),$("#s2"),$("#s3"),$("#s4"),$("#s5")];
var cur=0, enteredAt=0, rainTimer=null;

/* ---------- text helpers ---------- */
function words(el,text,step){
  el.textContent="";var ws=text.split(" ");
  ws.forEach(function(w,i){var s=document.createElement("span");s.className="w";s.textContent=w;s.style.setProperty("--d",(i*(step||.09)).toFixed(2)+"s");el.appendChild(s);if(i<ws.length-1)el.appendChild(document.createTextNode(" "));});
}
function letters(el,text){
  el.textContent="";var n=0;var ws=text.split(" ");
  ws.forEach(function(word,wi){
    var wrap=document.createElement("span");wrap.className="wd";var chars=[];
    Array.from(word).forEach(function(c){if(c==="️"&&chars.length)chars[chars.length-1]+=c;else chars.push(c);});
    chars.forEach(function(c){var s=document.createElement("span");s.className="ch";s.textContent=c;s.style.setProperty("--d",(n++*.045).toFixed(3)+"s");wrap.appendChild(s);});
    el.appendChild(wrap);if(wi<ws.length-1)el.appendChild(document.createTextNode(" "));
  });
}
function runSeq(scene,steps){
  cancelSeq(scene);scene._t=[];scene._steps=steps;
  steps.forEach(function(st){scene._t.push(setTimeout(function(){st[1](false)},RM?st[0]*.25:st[0]));});
}
function cancelSeq(scene){if(scene._t)scene._t.forEach(clearTimeout);scene._t=null;}
function skipSeq(scene){
  if(!scene._t)return;scene._t.forEach(clearTimeout);scene._t=null;scene.classList.add("skip");
  scene._steps.forEach(function(st){st[1](true)});
}
function showBtn(b){b.classList.remove("hide")}
function buildTexts(){
  words($("#s1line"),"Bu gecə sənin üçün hazırladığım balaca bir sirr var.",.1);
  words($("#l1"),"Bilirsən, bəzi insanlar var ki, onların varlığı adi bir günü belə gözəlləşdirir...",.08);
  words($("#l2"),"Mən də səninlə belə gözəl bir xatirə yaratmaq istəyirəm.",.09);
  words($("#l3"),"Bəlkə də ən gözəl hekayələr kiçik bir sualla başlayır...",.11);
  letters($("#yay"),"AYYYYY! BİZİM GÖRÜŞÜMÜZ VAR! ❤️");
}

/* ---------- 3D heart ---------- */
var HEART="M50 88C20 66 6 48 6 31C6 17 17 8 29 8C38 8 46 13 50 21C54 13 62 8 71 8C83 8 94 17 94 31C94 48 80 66 50 88Z";
function buildHeart(stage,orbit){
  var N=24,h='<div class="glow"></div><div class="beat"><div class="h3d">';
  for(var i=0;i<N;i++){
    var t=i/(N-1),k=(t-.5)*.2,sc=.9+.1*Math.sin(Math.PI*t),light=24+38*t;
    var fill=i===N-1?"url(#hgF)":"hsl(336 78% "+light.toFixed(1)+"%)";
    h+='<svg viewBox="0 0 100 100" style="transform:translateZ(calc(var(--hs) * '+k.toFixed(3)+')) scale('+sc.toFixed(3)+')"><path d="'+HEART+'" fill="'+fill+'"/></svg>';
  }
  h+="</div></div>";
  if(orbit)h+='<div class="orbit"><i>✦</i><i>✦</i><i>✦</i></div>';
  stage.innerHTML=h;
}

/* ---------- background: stars, dust, shooting stars ---------- */
var bg=$("#bg"),bctx=bg.getContext("2d"),fxc=$("#fx"),fx=fxc.getContext("2d");
var W=0,H=0,DPR=1,stars=[],dust=[],shoot=null,nextShoot=0;
function sizeCanvases(){
  DPR=Math.min(window.devicePixelRatio||1,2);W=window.innerWidth;H=window.innerHeight;
  [bg,fxc].forEach(function(c){c.width=Math.round(W*DPR);c.height=Math.round(H*DPR);c.getContext("2d").setTransform(DPR,0,0,DPR,0,0);});
  var n=Math.min(LOW?90:170,Math.round(W*H/5200));stars=[];
  for(var i=0;i<n;i++)stars.push({x:Math.random()*W,y:Math.random()*H,r:rand(.4,1.5),p:rand(0,6.28),s:rand(.6,2.2),c:pick(["#fff","#fff","#ffe9c4","#d9ccff"])});
  dust=[];var dn=LOW?18:34;
  for(i=0;i<dn;i++)dust.push({x:Math.random()*W,y:Math.random()*H,r:rand(1.5,4.5),vy:rand(.08,.3),vx:rand(-.1,.1),p:rand(0,6.28),c:pick(["255,140,190","243,217,164","201,182,255"])});
  drawBg(0);
}
function drawBg(t){
  bctx.clearRect(0,0,W,H);
  for(var i=0;i<stars.length;i++){var s=stars[i];var a=RM?.7:.35+.65*Math.abs(Math.sin(t/1000*s.s+s.p));bctx.globalAlpha=a;bctx.fillStyle=s.c;bctx.beginPath();bctx.arc(s.x,s.y,s.r,0,6.283);bctx.fill();}
  bctx.globalAlpha=1;
  if(!RM){
    for(i=0;i<dust.length;i++){var d=dust[i];d.y-=d.vy;d.x+=d.vx+Math.sin(t/2000+d.p)*.2;if(d.y<-10){d.y=H+10;d.x=Math.random()*W;}
      var g=bctx.createRadialGradient(d.x,d.y,0,d.x,d.y,d.r*3);var al=.35+.25*Math.sin(t/900+d.p);
      g.addColorStop(0,"rgba("+d.c+","+al+")");g.addColorStop(1,"rgba("+d.c+",0)");bctx.fillStyle=g;bctx.beginPath();bctx.arc(d.x,d.y,d.r*3,0,6.283);bctx.fill();}
    if(!shoot&&t>nextShoot){shoot={x:rand(W*.2,W),y:rand(0,H*.4),l:0};nextShoot=t+rand(5000,10000);}
    if(shoot){shoot.l+=1;var L=shoot.l,x=shoot.x-L*9,y=shoot.y+L*5;var gr=bctx.createLinearGradient(x,y,x+90,y-50);gr.addColorStop(0,"rgba(255,255,255,0)");gr.addColorStop(1,"rgba(255,244,214,.95)");
      bctx.strokeStyle=gr;bctx.lineWidth=1.6;bctx.beginPath();bctx.moveTo(x,y);bctx.lineTo(x+90,y-50);bctx.stroke();if(L>60)shoot=null;}
  }
}
function bgLoop(t){if(!document.hidden)drawBg(t);requestAnimationFrame(bgLoop)}

/* ---------- fx engine (hearts, confetti, stars, sparks) ---------- */
var P=[],running=false,lastT=0,sprites={};
function heartSprite(c){
  if(sprites["h"+c])return sprites["h"+c];
  var o=document.createElement("canvas");o.width=o.height=96;var x=o.getContext("2d");
  x.translate(8,7);x.scale(.8,.8);var p=new Path2D(HEART);x.shadowColor=c;x.shadowBlur=10;x.fillStyle=c;x.fill(p);x.shadowBlur=0;
  x.globalCompositeOperation="source-atop";var g=x.createRadialGradient(34,26,2,50,50,60);g.addColorStop(0,"rgba(255,255,255,.75)");g.addColorStop(.4,"rgba(255,255,255,0)");g.addColorStop(1,"rgba(0,0,0,.18)");x.fillStyle=g;x.fill(p);
  return sprites["h"+c]=o;
}
function starSprite(c){
  if(sprites["s"+c])return sprites["s"+c];
  var o=document.createElement("canvas");o.width=o.height=64;var x=o.getContext("2d");
  var g=x.createRadialGradient(32,32,0,32,32,30);g.addColorStop(0,"rgba(255,255,255,.95)");g.addColorStop(.25,c);g.addColorStop(1,"rgba(255,255,255,0)");x.fillStyle=g;x.fillRect(0,0,64,64);
  x.fillStyle="#fff";x.beginPath();x.moveTo(32,2);x.quadraticCurveTo(34,30,62,32);x.quadraticCurveTo(34,34,32,62);x.quadraticCurveTo(30,34,2,32);x.quadraticCurveTo(30,30,32,2);x.fill();
  return sprites["s"+c]=o;
}
var HC=["#ff5c9d","#ff8fb8","#ffc2d9","#f3d9a4","#c9b6ff","#ff3d7f"];
var CC=["#ff5c9d","#ff8fb8","#f3d9a4","#ffe9c4","#c9b6ff","#ffffff","#e8b86b"];
var SC=["rgba(255,236,190,1)","rgba(255,170,205,1)","rgba(215,200,255,1)"];
function add(p){p.age=0;P.push(p);if(!running){running=true;lastT=performance.now();requestAnimationFrame(tick);}}
function tick(t){
  var dt=Math.min(2.5,(t-lastT)/16.67);lastT=t;fx.clearRect(0,0,W,H);
  for(var i=P.length-1;i>=0;i--){
    var p=P[i];p.age+=dt;if(p.age>=p.life){P.splice(i,1);continue;}
    var dr=Math.pow(p.drag,dt);p.vx*=dr;p.vy=p.vy*dr+p.g*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.r+=p.vr*dt;
    var k=p.age/p.life,a=k<.1?k/.1:(k>.72?(1-k)/.28:1);
    fx.globalAlpha=Math.max(0,a);fx.save();fx.translate(p.x,p.y);fx.rotate(p.r);
    if(p.t==="heart"){fx.drawImage(p.img,-p.s/2,-p.s/2,p.s,p.s);}
    else if(p.t==="conf"){fx.scale(1,Math.cos(p.age*p.fs));fx.fillStyle=p.c;fx.fillRect(-p.s/2,-p.s*.3,p.s,p.s*.6);}
    else{fx.globalCompositeOperation="lighter";var z=p.s*(.75+.25*Math.sin(p.age*.15+p.ph));fx.drawImage(p.img,-z/2,-z/2,z,z);}
    fx.restore();
  }
  fx.globalAlpha=1;
  if(P.length)requestAnimationFrame(tick);else{running=false;fx.clearRect(0,0,W,H);}
}
function sparkAt(x,y,n){
  if(RM)return;
  for(var i=0;i<n;i++){var a=rand(0,6.28),sp=rand(.4,2.4);add({t:"star",x:x,y:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-.6,g:.03,drag:.97,r:0,vr:rand(-.03,.03),s:rand(10,22),ph:rand(0,6),life:rand(35,65),img:starSprite(pick(SC))});}
}
function confetti(x,y,base,n,spread,speed){
  var sc=Math.min(W,H)/700+.35;
  for(var i=0;i<n;i++){var a=base+rand(-spread,spread),sp=rand(.45,1)*speed*sc;
    add({t:"conf",x:x,y:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,g:.26,drag:.985,r:rand(0,6),vr:rand(-.2,.2),s:rand(7,13),fs:rand(.15,.4),c:pick(CC),life:rand(200,330)});}
}
function boom(){
  var cx=W/2,cy=H*.42,sc=Math.min(W,H)/700+.35,f=LOW?.6:1,i,a;
  var ring=$("#ring");ring.classList.remove("go");void ring.offsetWidth;ring.classList.add("go");
  for(i=0;i<Math.round(100*f);i++){a=rand(0,6.283);var sp=rand(3,15)*sc;
    add({t:"heart",x:cx,y:cy,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-2,g:.1,drag:.982,r:rand(-.6,.6),vr:rand(-.04,.04),s:rand(18,56),img:heartSprite(pick(HC)),life:rand(100,190)});}
  for(i=0;i<Math.round(60*f);i++){add({t:"star",x:rand(0,W),y:rand(0,H),vx:rand(-.2,.2),vy:rand(-.3,.1),g:0,drag:1,r:0,vr:rand(-.01,.01),s:rand(18,46),ph:rand(0,6),life:rand(140,280),img:starSprite(pick(SC))});}
  confetti(0,H,-1.15,Math.round(110*f),.35,26);
  confetti(W,H,-2.0,Math.round(110*f),.35,26);
  confetti(W/2,H*.6,-1.57,Math.round(80*f),.6,24);
  var n=0;clearInterval(rainTimer);
  rainTimer=setInterval(function(){
    n++;for(var j=0;j<Math.round(6*f);j++)add({t:"conf",x:rand(0,W),y:-12,vx:rand(-1,1),vy:rand(1.5,4),g:.05,drag:.995,r:rand(0,6),vr:rand(-.15,.15),s:rand(7,12),fs:rand(.1,.3),c:pick(CC),life:rand(220,320)});
    if(n%5===0)add({t:"heart",x:rand(0,W),y:H+20,vx:rand(-.6,.6),vy:rand(-4.5,-2.5),g:-.01,drag:.998,r:0,vr:rand(-.02,.02),s:rand(18,34),img:heartSprite(pick(HC)),life:rand(180,260)});
    if(n>46||cur!==4){clearInterval(rainTimer);rainTimer=null;}
  },RM?400:130);
}

/* ---------- navigation ---------- */
function go(n){
  cur=n;enteredAt=Date.now();
  scenes.forEach(function(s,i){s.classList.toggle("active",i===n-1);});
  document.body.setAttribute("data-scene",String(n));
  $("#floatLayer").classList.toggle("on",n===3);
  scenes[n-1].scrollTop=0;
  if(n===1)enter1();if(n===2)enter2();if(n===3)enter3();if(n===4)enter4();if(n===5)enter5();
}
function enter1(){
  var s=$("#s1");s.classList.remove("skip","opening");$("#env").className="env";$("#s1name").classList.remove("go");$("#s1line").classList.remove("go");$("#openBtn").classList.add("hide");
  runSeq(s,[[900,function(){$("#s1name").classList.add("go")}],[2900,function(){$("#s1line").classList.add("go")}],[5600,function(){showBtn($("#openBtn"))}]]);
}
function enter2(){
  var s=$("#s2");s.classList.remove("skip");["#l1","#l2","#l3"].forEach(function(q){$(q).classList.remove("go")});$("#toQ").classList.add("hide");
  runSeq(s,[[1100,function(){$("#l1").classList.add("go")}],[4400,function(){$("#l2").classList.add("go")}],[7300,function(){$("#l3").classList.add("go")}],[10200,function(){showBtn($("#toQ"))}]]);
}
function enter4(){
  var s=$("#s4");s.classList.remove("skip");$("#yay").classList.remove("go");$("#y1").classList.remove("go");$("#y2").classList.remove("go");$("#toInvite").classList.add("hide");
  runSeq(s,[[900,function(){$("#yay").classList.add("go")}],[3400,function(){$("#y1").classList.add("go")}],[5600,function(){$("#y2").classList.add("go")}],[8400,function(){showBtn($("#toInvite"))}]]);
}
function enter5(){cancelSeq(scenes[3]);}
scenes.forEach(function(s,i){
  s.addEventListener("pointerup",function(e){
    if(i===2||i===4)return;
    if(e.target.closest&&e.target.closest("button"))return;
    if(Date.now()-enteredAt<1400)return;
    skipSeq(s);
  });
});

/* envelope */
$("#openBtn").addEventListener("click",function(){
  var env=$("#env"),s=$("#s1");if(env.classList.contains("open"))return;
  cancelSeq(s);s.classList.add("opening");env.classList.add("open");
  var r=env.getBoundingClientRect();sparkAt(r.left+r.width/2,r.top+r.height*.4,18);
  setTimeout(function(){var r2=env.getBoundingClientRect();sparkAt(r2.left+r2.width/2,r2.top,24);},900);
  setTimeout(function(){env.classList.add("fly")},1900);
  setTimeout(function(){go(2)},2900);
});
$("#toQ").addEventListener("click",function(){go(3)});
$("#toInvite").addEventListener("click",function(){go(5)});

/* ---------- scene 3: YES and the escaping NO ---------- */
var no=$("#no"),yesB=$("#yes"),slot=$("#noSlot"),qCard=$("#qCard"),msg=$("#msg"),sparks=$("#sparks"),probe=$("#probe");
var MSGS=["Əminsən, Aysu? 🥺","Bir də düşün...","Məncə, sən HƏ demək istəyirsən 😂","Bu qədər qaçma da 🙈","Ürəyimi qırma, Aysu ❤️","Son qərarın budur? 🥹","Bir balaca şans ver..."];
var esc=0,ys=1,lock=false,noPos={x:0,y:0,r:0,s:1};
function vpSize(){return{w:document.documentElement.clientWidth||window.innerWidth,h:window.innerHeight};}
function insets(){var cs=getComputedStyle(probe);return{t:parseFloat(cs.paddingTop)||0,r:parseFloat(cs.paddingRight)||0,b:parseFloat(cs.paddingBottom)||0,l:parseFloat(cs.paddingLeft)||0};}
function noScale(){return Math.max(.8,1-esc*.03);}
function setNo(x,y,r,s,snap){
  noPos={x:x,y:y,r:r,s:s};
  if(snap)no.classList.add("snap");else no.classList.remove("snap");
  no.style.transform="translate3d("+x.toFixed(1)+"px,"+y.toFixed(1)+"px,0) rotate("+r.toFixed(1)+"deg) scale("+s.toFixed(3)+")";
}
function scaleFor(n){
  var base=yesB.offsetWidth||200,vw=vpSize().w;
  var cap=Math.max(1,Math.min(1.8,(vw-36)/base));
  return Math.min(cap,1+n*.13);
}
function applyYes(s,n){
  ys=s;yesB.style.setProperty("--ys",s.toFixed(3));
  yesB.style.setProperty("--yb",Math.min(1.5,1+n*.07).toFixed(2));
  yesB.style.setProperty("--yg",(24+n*9)+"px");
}
function forbidden(nextScale){
  var out=[];
  [qCard,msg].forEach(function(e){var r=e.getBoundingClientRect();out.push({l:r.left-10,r:r.right+10,t:r.top-10,b:r.bottom+10});});
  var r=yesB.getBoundingClientRect(),f=nextScale/ys,cx=r.left+r.width/2,cy=r.top+r.height/2,w=r.width*f/2,h=r.height*f/2;
  out.push({l:cx-w-16,r:cx+w+16,t:cy-h-16,b:cy+h+16});
  return out;
}
function choose(px,py,nextScale,ns){
  var V=vpSize(),I=insets(),pad=12;
  var w=no.offsetWidth*ns,h=no.offsetHeight*ns;
  var minX=I.l+pad,maxX=V.w-I.r-w-pad,minY=I.t+pad,maxY=V.h-I.b-h-pad;
  if(maxX<minX)maxX=minX;if(maxY<minY)maxY=minY;
  var forb=forbidden(nextScale);
  var ccx=noPos.x+w/2,ccy=noPos.y+h/2,minMove=Math.min(V.w,V.h)*.28;
  function ok(x,y){for(var i=0;i<forb.length;i++){var f=forb[i];if(x<f.r&&x+w>f.l&&y<f.b&&y+h>f.t)return false;}return true;}
  function far(x,y,d){return px==null||Math.hypot(x+w/2-px,y+h/2-py)>d;}
  var good=[],i,x,y;
  for(i=0;i<160&&good.length<8;i++){x=rand(minX,maxX);y=rand(minY,maxY);
    if(ok(x,y)&&far(x,y,110)&&Math.hypot(x+w/2-ccx,y+h/2-ccy)>minMove)good.push([x,y]);}
  if(good.length)return pick(good);
  for(i=0;i<200;i++){x=rand(minX,maxX);y=rand(minY,maxY);if(ok(x,y)&&far(x,y,60))good.push([x,y]);}
  if(good.length)return pick(good);
  var best=null,bd=-1;
  for(x=minX;x<=maxX;x+=16)for(y=minY;y<=maxY;y+=16){if(!ok(x,y))continue;var d=px==null?0:Math.hypot(x+w/2-px,y+h/2-py);if(d>bd){bd=d;best=[x,y];}}
  if(best)return best;
  return [minX,maxY];
}
function burst(x,y,n){
  if(RM)return;
  var g=["💖","✨","💗","⭐","💫","🩷"];
  for(var i=0;i<n;i++){if(sparks.childElementCount>40)break;var s=document.createElement("span");s.textContent=pick(g);s.style.left=x+"px";s.style.top=y+"px";
    s.style.setProperty("--dx",rand(-80,80).toFixed(0)+"px");s.style.setProperty("--dy",rand(-130,-30).toFixed(0)+"px");s.style.setProperty("--s",rand(.8,1.5).toFixed(2));s.style.setProperty("--rot",rand(-40,40).toFixed(0)+"deg");
    s.addEventListener("animationend",function(){this.remove()});sparks.appendChild(s);}
}
function escapeNo(px,py){
  if(cur!==3||lock)return;
  lock=true;setTimeout(function(){lock=false},240);
  esc++;
  var old=no.getBoundingClientRect();burst(old.left+old.width/2,old.top+old.height/2,7);sparkAt(old.left+old.width/2,old.top+old.height/2,6);
  var ns=noScale(),nextY=scaleFor(esc),spot=choose(px,py,nextY,ns);
  applyYes(nextY,esc);
  var i=esc<=7?esc-1:3+((esc-8)%4);msg.textContent=MSGS[i];msg.classList.remove("pop");void msg.offsetWidth;msg.classList.add("pop");
  no.style.setProperty("--td",rand(.34,.66).toFixed(2)+"s");
  setNo(spot[0],spot[1],rand(-14,14),ns,false);
  try{if(navigator.vibrate)navigator.vibrate(12);}catch(e){}
}
function relocate(){
  if(cur!==3||esc===0)return;
  var ns=noScale(),y=scaleFor(esc);applyYes(y,esc);
  var spot=choose(null,null,y,ns);no.style.setProperty("--td",".3s");setNo(spot[0],spot[1],0,ns,false);
}
function track(){
  if(cur!==3||esc>0)return;
  var r=slot.getBoundingClientRect();slot.style.width=no.offsetWidth+"px";slot.style.height=no.offsetHeight+"px";
  setNo(r.left,r.top,0,1,true);requestAnimationFrame(track);
}
function enter3(){
  esc=0;ys=1;lock=false;applyYes(1,0);msg.textContent="Ürəyin nə deyir? 💭";
  slot.style.width=no.offsetWidth+"px";slot.style.height=no.offsetHeight+"px";
  requestAnimationFrame(track);
}
function near(x,y,rad){var r=no.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;return Math.hypot(x-cx,y-cy)<Math.max(r.width,r.height)/2+rad;}
var hit=function(e){e.preventDefault();var t=e.touches&&e.touches[0],c=e.changedTouches&&e.changedTouches[0];var p=t||c;escapeNo(p?p.clientX:e.clientX,p?p.clientY:e.clientY);};
no.addEventListener("touchstart",hit,{passive:false});
no.addEventListener("pointerdown",hit);
no.addEventListener("pointerenter",function(e){escapeNo(e.clientX,e.clientY)});
no.addEventListener("mouseenter",function(e){escapeNo(e.clientX,e.clientY)});
no.addEventListener("mouseover",function(e){escapeNo(e.clientX,e.clientY)});
no.addEventListener("mousedown",hit);
no.addEventListener("click",hit);
no.addEventListener("focus",function(){escapeNo(null,null)});
document.addEventListener("pointermove",function(e){if(cur===3&&e.pointerType==="mouse"&&near(e.clientX,e.clientY,44))escapeNo(e.clientX,e.clientY);},{passive:true});
document.addEventListener("touchmove",function(e){if(cur!==3)return;var t=e.touches[0];if(t&&near(t.clientX,t.clientY,34))escapeNo(t.clientX,t.clientY);},{passive:true});
document.addEventListener("touchstart",function(e){if(cur!==3)return;var t=e.touches[0];if(t&&e.target!==no&&near(t.clientX,t.clientY,26))escapeNo(t.clientX,t.clientY);},{passive:true});

/* YES */
yesB.addEventListener("click",function(){
  if(cur!==3)return;
  try{if(navigator.vibrate)navigator.vibrate([40,60,40,60,120]);}catch(e){}
  var f=$("#flash");f.classList.remove("go");void f.offsetWidth;f.classList.add("go");
  go(4);setTimeout(boom,180);
});

/* sparkle trail + tap sparkles (not on scene 3 buttons) */
var lastTrail=0;
document.addEventListener("pointerdown",function(e){if(e.target===no)return;sparkAt(e.clientX,e.clientY,5);},{passive:true});
document.addEventListener("pointermove",function(e){if(e.pointerType==="mouse"&&e.buttons===0)return;var n=Date.now();if(n-lastTrail>55){lastTrail=n;sparkAt(e.clientX,e.clientY,1);}},{passive:true});

/* ---------- scene 5 ---------- */
var KEY="aysu-invite-v1",saved={};
try{saved=JSON.parse(localStorage.getItem(KEY)||"{}")||{};}catch(e){saved={};}
var saveNote=$("#saveNote"),saveT=null;
$$(".fval").forEach(function(el){
  var k=el.dataset.key;el.textContent=saved[k]||"";
  el.addEventListener("input",function(){
    var tx=el.textContent;if(tx.length>90){tx=tx.slice(0,90);el.textContent=tx;}
    if(!tx.trim())el.textContent="";
    saved[k]=el.textContent.trim();
    try{localStorage.setItem(KEY,JSON.stringify(saved));}catch(e){}
    saveNote.classList.add("on");clearTimeout(saveT);saveT=setTimeout(function(){saveNote.classList.remove("on")},1600);
  });
  el.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();el.blur();}});
  el.addEventListener("paste",function(e){
    e.preventDefault();var t=(e.clipboardData||window.clipboardData).getData("text").replace(/\s+/g," ");
    try{document.execCommand("insertText",false,t);}catch(err){el.textContent+=t;}
  });
});
function inviteText(){
  var ph="Bəzi sürprizlər əvvəlcədən bilinməməlidir... ❤️";
  function v(k){return saved[k]||ph}
  return "Aysu üçün görüş dəvətnaməsi ❤️\nGörüş günü: "+v("day")+"\nGörüş saatı: "+v("time")+"\nGörüş məkanı: "+v("place")+"\nKiçik sürpriz: "+v("gift")+"\n\nBu, sadəcə bir görüş deyil. Bəlkə də ən gözəl xatirələrimizdən birinin başlanğıcıdır.\nSevgilərlə ❤️";
}
var copyBtn=$("#copyBtn");
copyBtn.addEventListener("click",function(){
  var t=inviteText(),done=function(){copyBtn.textContent="Kopyalandı ✓";setTimeout(function(){copyBtn.textContent="Təfərrüatları kopyala"},1800);};
  function fallback(){var ta=document.createElement("textarea");ta.value=t;ta.setAttribute("readonly","");ta.style.cssText="position:fixed;left:-9999px;top:0;opacity:0";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");}catch(e){}ta.remove();done();}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,fallback);}else fallback();
});
$("#replayBtn").addEventListener("click",function(){
  clearInterval(rainTimer);P.length=0;sparks.textContent="";esc=0;buildTexts();go(1);
});

/* ---------- boot ---------- */
window.addEventListener("resize",function(){sizeCanvases();relocate();});
window.addEventListener("orientationchange",function(){setTimeout(function(){sizeCanvases();relocate();},250);});
if(window.visualViewport)window.visualViewport.addEventListener("resize",function(){relocate();});
buildTexts();buildHeart($("#heart2"),true);buildHeart($("#heart4"),false);
sizeCanvases();
if(!RM)requestAnimationFrame(bgLoop);
var started=false;function start(){if(started)return;started=true;go(1);}
if(document.fonts&&document.fonts.ready){document.fonts.ready.then(start);setTimeout(start,1200);}else start();
})();
</script>

<script>
/* ---------- Backend inteqrasiyası ---------- */
(function(){
  "use strict";
  var q=new URLSearchParams(location.search);
  var TOKEN=q.get("admin")||sessionStorage.getItem("aysu-admin")||"";
  if(q.get("admin")){try{sessionStorage.setItem("aysu-admin",TOKEN);}catch(e){} history.replaceState(null,"",location.pathname);}
  var isAdmin=!!TOKEN;
  function post(body){try{fetch("/api/events",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),keepalive:true}).catch(function(){});}catch(e){}}

  /* 1) Dəvətnamə sahələrini serverdən yüklə */
  var fields=Array.prototype.slice.call(document.querySelectorAll(".fval")),loading=true;
  fields.forEach(function(el){ if(!isAdmin) el.setAttribute("contenteditable","false"); });
  if(!isAdmin) Array.prototype.forEach.call(document.querySelectorAll(".flabel b"),function(b){b.style.display="none"});
  fetch("/api/invite").then(function(r){return r.json()}).then(function(d){
    var inv=d.invite||{};
    fields.forEach(function(el){
      el.textContent=inv[el.dataset.key]||"";
      el.dispatchEvent(new Event("input",{bubbles:true})); /* yerli yaddaş + kopyala düyməsi sinxron olsun */
    });
  }).catch(function(){}).then(function(){loading=false;});

  /* 2) Yalnız admin dəyişəndə serverə yaz */
  var t=null;
  fields.forEach(function(el){
    el.addEventListener("input",function(){
      if(!isAdmin||loading)return;
      clearTimeout(t);
      t=setTimeout(function(){
        var body={};fields.forEach(function(f){body[f.dataset.key]=f.textContent.trim();});
        fetch("/api/invite",{method:"PUT",headers:{"Content-Type":"application/json","Authorization":"Bearer "+TOKEN},body:JSON.stringify(body)})
          .then(function(r){ if(r.status===401){alert("Admin token yanlışdır");} }).catch(function(){});
      },600);
    });
  });

  /* 3) Hadisələr: açılış, "Yox" qaçışı, "Həə" */
  post({type:"open"});
  var escapes=0,msg=document.getElementById("msg"),last="";
  new MutationObserver(function(){
    var cur=msg.textContent;
    if(cur!==last && cur!=="Ürəyin nə deyir? 💭"){escapes++;post({type:"no_escape",count:escapes});}
    last=cur;
  }).observe(msg,{childList:true,characterData:true,subtree:true});
  document.getElementById("yes").addEventListener("click",function(){post({type:"yes",escapes:escapes});});
  document.getElementById("replayBtn").addEventListener("click",function(){escapes=0;last="";});
})();
</script>
`;
