// tokenswrapped.com. Static files come from site/. This script only handles:
//   POST /api/card   a recap card someone chose to post: a 1600x900 PNG, kept 90 days, then deleted.
//   GET  /c/<id>     a page whose link preview is that card, so X shows the image under the post.
//   GET  /c/<id>.png the image.
// Nothing else is stored: no names, no stats, no logs. Uploads are rate-limited per IP (counter kept 2 days).

const DAY = 86400;
const KEEP = 90 * DAY;
const MAX_BYTES = 4_000_000;
const PER_IP_PER_DAY = 30;
const ID = /^[A-Za-z0-9]{12}$/;

function cors(res) {
  // The recap page is a local file (origin "null"), so the upload has to be allowed from anywhere.
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function newId() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

// A PNG of exactly 1600x900: the wide recap card. Anything else is refused.
export function isCardPng(b) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return false;
  const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return String.fromCharCode(b[12], b[13], b[14], b[15]) === 'IHDR' && u32(16) === 1600 && u32(20) === 900;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function cardPage(origin, id) {
  const img = `${origin}/c/${id}.png`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>My year in AI</title>
<meta name="description" content="Made with tokens-wrapped. Get yours: npx tokens-wrapped">
<meta property="og:title" content="My year in AI"><meta property="og:description" content="Made with tokens-wrapped. Get yours: npx tokens-wrapped">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1600"><meta property="og:image:height" content="900">
<meta property="og:url" content="${esc(`${origin}/c/${id}`)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(img)}">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:24px 16px;box-sizing:border-box;
background:radial-gradient(1200px 700px at 50% -10%,#2a2160 0%,#0b0a14 60%);color:#fff;font-family:"ABC Diatype",system-ui,-apple-system,"Segoe UI",sans-serif}
img{width:min(900px,100%);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.5)}a{color:#fff}
code{font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,.12);padding:6px 10px;border-radius:999px}</style></head>
<body><img src="${esc(img)}" alt="A year in AI recap card"><p>Get yours: <code>npx tokens-wrapped</code></p><p><a href="/">tokenswrapped.com</a></p></body></html>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/card') {
      if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (req.method !== 'POST') return cors(json({ error: 'POST a card image' }, 405));
      const ip = req.headers.get('cf-connecting-ip') || 'unknown';
      const rl = `rl:${new Date().toISOString().slice(0, 10)}:${ip}`;
      const count = Number((await env.CARDS.get(rl)) || 0);
      if (count >= PER_IP_PER_DAY) return cors(json({ error: 'too many cards today' }, 429));
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_BYTES) return cors(json({ error: 'too big' }, 413));
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) return cors(json({ error: 'too big' }, 413));
      if (!isCardPng(new Uint8Array(buf))) return cors(json({ error: 'not a card image' }, 400));
      const id = newId();
      await env.CARDS.put(`c:${id}`, buf, { expirationTtl: KEEP });
      await env.CARDS.put(rl, String(count + 1), { expirationTtl: 2 * DAY });
      return cors(json({ id, url: `${url.origin}/c/${id}` }));
    }
    const m = /^\/c\/([A-Za-z0-9]+)(\.png)?$/.exec(url.pathname);
    if (m && ID.test(m[1])) {
      const img = await env.CARDS.get(`c:${m[1]}`, 'arrayBuffer');
      if (!img) return Response.redirect(`${url.origin}/`, 302);
      if (m[2]) return new Response(img, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
      return new Response(cardPage(url.origin, m[1]), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' },
      });
    }
    return env.ASSETS.fetch(req);
  },
};
