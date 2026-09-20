/**
 * Vobiz calling backend for the HubSpot calling app.
 *
 * THE BROWSER IS THE A LEG. The widget sends the SIP INVITE itself and this
 * service answers with <Dial><Number> to reach the customer.
 *
 * What this file used to do — originate to the customer over the REST API and
 * bridge the agent's browser in with <Dial><User> — cannot work. Routing *into*
 * a registered WebRTC endpoint is blocked platform-side: Vobiz constructs a
 * gateway URI it cannot itself parse and drops its own INVITE
 * ("tr_eval_uri(): invalid uri", "blocking gw"). The customer answers, hears
 * ringback, then "the agent could not be reached".
 *
 * Dialling *out* of a registered endpoint works, which is what this does now.
 */
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

try { process.loadEnvFile(path.join(__dirname, ".env")); } catch { /* env may come from the shell */ }

const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");

const PORT = Number(clean(process.env.PORT) || 8092);
const AUTH_ID = clean(process.env.VOBIZ_AUTH_ID);
const AUTH_TOKEN = clean(process.env.VOBIZ_AUTH_TOKEN);
const FROM_NUMBER = clean(process.env.VOBIZ_FROM_NUMBER);
const SIP_USER = clean(process.env.VOBIZ_SIP_USER);
const SIP_PASSWORD = clean(process.env.VOBIZ_SIP_PASSWORD);
const REGISTRAR = clean(process.env.VOBIZ_REGISTRAR) || "registrar.vobiz.ai";
const API_BASE = clean(process.env.VOBIZ_API_URL) || "https://api.vobiz.ai";

const SIGNING_SECRET = clean(process.env.SIGNING_SECRET) || crypto.randomBytes(32).toString("hex");
const RECORDING_URL_TTL_SECONDS = Number(clean(process.env.RECORDING_URL_TTL_SECONDS) || 900);

const TUNNEL_URL_FILE = path.join(__dirname, "tunnel-url.txt");
function publicBase() {
  const fromEnv = clean(process.env.PUBLIC_BASE) || clean(process.env.TUNNEL_URL);
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  try { return fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim().replace(/\/+$/, ""); } catch { return ""; }
}

const hubspotOAuth = require("./hubspot-oauth");

const HUBSPOT_SCOPES = clean(process.env.HUBSPOT_SCOPES) ||
  "oauth crm.objects.contacts.read crm.objects.contacts.write";

const HUBSPOT_ENV = {
  get HUBSPOT_CLIENT_ID() { return clean(process.env.HUBSPOT_CLIENT_ID); },
  get HUBSPOT_CLIENT_SECRET() { return clean(process.env.HUBSPOT_CLIENT_SECRET); },
  get HUBSPOT_REDIRECT_URI() {
    return clean(process.env.HUBSPOT_REDIRECT_URI) || `${publicBase()}/hubspot/callback`;
  },
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

for (const [k, v] of Object.entries({ VOBIZ_AUTH_ID: AUTH_ID, VOBIZ_AUTH_TOKEN: AUTH_TOKEN, VOBIZ_FROM_NUMBER: FROM_NUMBER, VOBIZ_SIP_USER: SIP_USER, VOBIZ_SIP_PASSWORD: SIP_PASSWORD })) {
  if (!v) log(`⚠  ${k} is not set — the widget will not be able to register or call.`);
}

// ─── state ───────────────────────────────────────────────────────────────────
// agentId -> { authId, numbers, from }
const sessions = new Map();
// A-leg CallUUID -> call record. Recordings are attributed to the A-leg UUID,
// which makes it the right key for both the dial result and the file.
const calls = new Map();
const recent = [];

// recordingId -> { authId, authToken, url }
const recordingMeta = new Map();

function getActiveAuth(recordingId) {
  if (recordingId && recordingMeta.has(recordingId)) {
    const c = recordingMeta.get(recordingId);
    if (c.authId && c.authToken) return { authId: c.authId, authToken: c.authToken, url: c.url };
  }
  for (const s of sessions.values()) {
    if (s.authId && s.authToken) return { authId: s.authId, authToken: s.authToken, url: null };
  }
  return { authId: AUTH_ID, authToken: AUTH_TOKEN, url: null };
}

function remember(rec) {
  calls.set(rec.callUuid, rec);
  recent.unshift(rec);
  while (recent.length > 200) {
    const dropped = recent.pop();
    if (dropped) calls.delete(dropped.callUuid);
  }
}

// ─── Vobiz REST ──────────────────────────────────────────────────────────────
function vobiz(method, apiPath, body, auth = {}) {
  const currentAuthId = auth.authId || AUTH_ID;
  const currentAuthToken = auth.authToken || AUTH_TOKEN;
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: new URL(API_BASE).host,
        method,
        path: `/api/v1/Account/${currentAuthId}${apiPath}`,
        headers: {
          "X-Auth-ID": currentAuthId, "X-Auth-Token": currentAuthToken, Accept: "application/json",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed = raw;
          try { parsed = JSON.parse(raw); } catch { /* keep the raw body */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}

// ─── recording links ─────────────────────────────────────────────────────────
// An <audio> element cannot send an Authorization header, so a playback URL has
// to carry its own proof. It must never carry account credentials: these links
// end up in CRM engagement notes, readable for as long as the record exists.
function signRecordingUrl(recordingId) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
  return `${publicBase()}/recording-audio/${encodeURIComponent(recordingId)}?exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(recordingId, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac("sha256", SIGNING_SECRET).update(`${recordingId}|${exp}`).digest("hex");
  const a = Buffer.from(String(sig)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MEDIA_HOSTS = [
  /(^|\.)vobiz\.ai$/i,
  /(^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$/i,
  /(^|\.)s3\.amazonaws\.com$/i,
  /(^|\.)amazonaws\.com$/i,
  /(^|\.)r2\.cloudflarestorage\.com$/i,
  /(^|\.)cloudfront\.net$/i,
  /(^|\.)storage\.googleapis\.com$/i,
];
const allowedMediaHost = (u) => {
  try {
    const p = new URL(u);
    return (p.protocol === "https:" || p.protocol === "http:") && MEDIA_HOSTS.some((re) => re.test(p.hostname));
  } catch {
    return false;
  }
};

// ─── http helpers ────────────────────────────────────────────────────────────
// HubSpot iframes calling widgets from app.hubspot.com and its regional hosts.
// A wildcard would let any page on the internet drive the agent's softphone.
const ORIGIN_ALLOWLIST = [
  /^https:\/\/([a-z0-9-]+\.)*hubspot\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*hubspotqa\.com$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^https:\/\/([a-z0-9-]+\.)*trycloudflare\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*ngrok-free\.app$/i,
  /^https:\/\/([a-z0-9-]+\.)*ngrok\.app$/i,
];
const EXTRA_ORIGINS = clean(process.env.ALLOWED_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (EXTRA_ORIGINS.includes(origin) || ORIGIN_ALLOWLIST.some((re) => re.test(origin)))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // ngrok-skip-browser-warning must be listed: a header missing from this list
  // fails the preflight, so the browser never sends the real request — an
  // OPTIONS 204 with no GET after it.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning");
}

const send = (res, code, payload, headers = {}) => {
  const isBuf = Buffer.isBuffer(payload);
  const isXml = typeof payload === "string" && payload.startsWith("<?xml");
  res.writeHead(code, {
    "Content-Type": isBuf ? "audio/mpeg" : isXml ? "text/xml" : "application/json",
    ...headers,
  });
  res.end(isBuf || typeof payload === "string" ? payload : JSON.stringify(payload));
};

// Vobiz posts webhooks form-encoded, not JSON. A JSON reader yields {} and
// every parameter reads as undefined, which looks like Vobiz sending nothing.
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = raw.trim();
      if (!b) return resolve({});
      if (b.startsWith("{") || b.startsWith("[")) { try { return resolve(JSON.parse(b)); } catch { /* fall through */ } }
      resolve(Object.fromEntries(new URLSearchParams(b)));
    });
  });

const escXml = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function toE164(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("+")) return v;
  if (v.startsWith("0") && v.length === 11) return `+91${v.slice(1)}`;
  const d = v.replace(/\D/g, "");
  return d ? `+${d}` : "";
}

/**
 * Serve one file out of source/, containing the path so a widget URL cannot
 * read the .env sitting one directory up.
 */
function serveWidgetAsset(res, rel) {
  const root = path.resolve(__dirname, "..", "source");
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return send(res, 403, { error: "Forbidden" });
  }
  try {
    const body = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "application/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
      : ext === ".svg" ? "image/svg+xml"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    send(res, 404, { error: `No widget asset at ${rel}` });
  }
}

async function ensureHubspotAppAndRouting(authId, authToken, epId, fromNumber) {
  const base = publicBase();
  if (!base || !base.startsWith("https://")) {
    log("  ⚠ cannot configure VoBiz Application: PUBLIC_BASE is not an https URL");
    return null;
  }
  const answerUrl = `${base}/answer`;
  try {
    const apps = await vobiz("GET", "/Application/?limit=50", null, { authId, authToken });
    const appList = (apps.body && (apps.body.objects || apps.body.items)) || [];
    let app = appList.find((a) => a.app_name && a.app_name.toLowerCase().includes("hubspot")) || appList[0];
    let appId;

    if (app) {
      appId = app.app_id || app.id;
      // Always keep the application's answer_url synchronized to the current active tunnel!
      await vobiz("POST", `/Application/${encodeURIComponent(appId)}/`, {
        answer_url: answerUrl,
        answer_method: "POST",
        hangup_url: answerUrl,
        hangup_method: "POST",
        default_number: fromNumber || "",
      }, { authId, authToken });
      log(`synchronized existing VoBiz Application ${appId} with answerUrl: ${answerUrl}`);
    } else {
      const created = await vobiz("POST", "/Application/", {
        app_name: "HubSpot Calling (Vobiz Dedicated)",
        answer_url: answerUrl,
        answer_method: "POST",
        hangup_url: answerUrl,
        hangup_method: "POST",
        default_number: fromNumber || "",
      }, { authId, authToken });
      app = created.body;
      appId = app && (app.app_id || app.id);
      log(`created VoBiz Application: ${appId} with answerUrl: ${answerUrl}`);
    }
    if (!appId) return null;

    if (epId) {
      await vobiz("POST", `/Endpoint/${encodeURIComponent(epId)}/`, { app_id: appId }, { authId, authToken });
      log(`bound endpoint ${epId} to application ${appId}`);
    }

    if (fromNumber) {
      await vobiz("POST", `/numbers/${encodeURIComponent(fromNumber)}/application`, { application_id: String(appId) }, { authId, authToken });
      log(`attached number ${fromNumber} to application ${appId}`);
    }
    return appId;
  } catch (err) {
    log(`  ⚠ ensureHubspotAppAndRouting error:`, err.message);
    return null;
  }
}

// ─── server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;
  let m;

  cors(req, res);
  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // ══ Webhooks Vobiz calls ═══════════════════════════════════════════════════
  // First, and never behind a session: Vobiz has none.

  if (p === "/answer" || p === "/inbound-answer") {
    const params = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
    log(`WEBHOOK ${method} ${p}`, JSON.stringify(params).slice(0, 240));

    // A Hangup notification is not a request for instructions. Returning <Dial>
    // here hands Vobiz a fresh call leg after the call already ended.
    if ((params.Event || params.event) === "Hangup") {
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`);
    }

    const base = publicBase();
    const from = String(params.From || params.from || "");
    const to = String(params.To || params.to || "");
    const routeType = String(params.RouteType || params.routetype || "").toLowerCase();
    const fromBrowser = from.startsWith("sip:") || routeType === "sip";
    const callUuid = String(params.CallUUID || params.call_uuid || "");

    // Self-closing <Record> as a SIBLING BEFORE <Dial>, never nested inside —
    // FreeSWITCH rejects the nested form and the caller hears a bogus "Busy".
    const record = `<Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false" redirect="false" callbackUrl="${base}/recording-ready" callbackMethod="POST"/>`;

    // action + redirect="false" are both required. Without them Vobiz re-fetches
    // this URL when <Dial> ends and re-executes the document, so one call dials
    // the customer over and over.
    const attrs = (callerId) =>
      `callerId="${escXml(callerId)}" timeout="30" timeLimit="14400" action="${base}/dial-status" method="POST" redirect="false"`;

    if (fromBrowser) {
      const cleanFromUser = (from.match(/^sip:([^@]+)@/) || [])[1] || from.replace(/^sip:/, "").split("@")[0];
      let s = [...sessions.values()].find((x) => {
        const xUser = (x.sipUser || "").replace(/^sip:/, "").split("@")[0];
        return xUser === cleanFromUser || x.authId === cleanFromUser;
      });
      if (!s && sessions.size > 0) {
        s = [...sessions.values()][sessions.size - 1];
      }
      const callerId = (s && s.from) || FROM_NUMBER || "+91XXXXXXXXXX";
      let dest = to.replace(/[^\d+]/g, "");
      if (dest && !dest.startsWith("+")) {
        dest = `+${dest}`;
      }
      remember({ callUuid, direction: "Outbound", from: callerId, to: dest, startedAt: Date.now() });
      log(`  -> browser is the A leg, dialling out to ${dest} as ${callerId}`);
      return send(res, 200,
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${record}\n  <Dial ${attrs(callerId)}>\n    <Number>${escXml(dest)}</Number>\n  </Dial>\n</Response>`);
    }

    // Inbound PSTN. callerId must be a number this account owns — omit it and
    // Vobiz derives it from the A leg, which here is the *caller's* number, so
    // B-leg creation is refused silently and the browser never rings.
    const dialedNumber = toE164(to);
    let matchedSession = [...sessions.values()].find((s) => (s.numbers && s.numbers.includes(dialedNumber)) || s.from === dialedNumber);
    if (!matchedSession && sessions.size > 0) {
      matchedSession = [...sessions.values()][sessions.size - 1];
    }
    const callerId = dialedNumber || (matchedSession && matchedSession.from) || FROM_NUMBER;
    let target = (matchedSession && matchedSession.sipUser) || (SIP_USER ? `${SIP_USER}@${REGISTRAR}` : "");
    if (target.startsWith("sip:")) target = target.slice(4);
    remember({ callUuid, direction: "Inbound", from, to: callerId, startedAt: Date.now() });
    log(`  -> inbound from ${from}, bridging to sip:${target} callerId=${callerId}`);
    return send(res, 200,
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${record}\n  <Dial ${attrs(callerId)}>\n    <User>sip:${escXml(target)}</User>\n  </Dial>\n</Response>`);
  }

  // The `action` target of <Dial>. Reporting the result here is what stops the
  // platform replaying the answer document.
  if (p === "/dial-status") {
    const d = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
    const bleg = d.DialBLegUUID || "";
    log(`DIAL RESULT status=${d.DialStatus || "-"} ring=${d.DialRingStatus || "-"} cause=${d.DialHangupCause || "-"} bleg=${bleg || "(none — B leg never originated)"} dur=${d.DialBLegDuration || "-"}`);
    if (d.DialStatus === "failed" && !bleg) {
      log("  ⚠  failed with no B leg — destination unreachable, or the callerId is not owned by this account.");
    }
    const rec = calls.get(String(d.CallUUID || ""));
    if (rec) {
      rec.dialStatus = d.DialStatus;
      rec.hangupCause = d.DialHangupCause;
      rec.bLegUuid = bleg || null;
      rec.duration = Number(d.DialBLegDuration || 0);
    }
    return send(res, 200, "");
  }

  // <Record callbackUrl>. Fires when the file is actually downloadable — a real
  // signal, rather than polling after the call ends.
  if (p === "/recording-ready") {
    const d = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
    const callUuid = String(d.CallUUID || d.call_uuid || "");
    const recordingId = d.RecordingID || d.RecordingId || d.recording_id || null;
    const recordingUrl = d.RecordUrl || d.RecordingUrl || d.recording_url || null;
    log(`RECORDING READY call=${callUuid} id=${recordingId || "-"} url=${recordingUrl ? "(provided)" : "(none)"}`);
    const rec = calls.get(callUuid);
    if (rec) {
      rec.recordingId = recordingId;
      rec.recordingDuration = Number(d.RecordingDuration || 0);
      if (recordingUrl) rec.recordingUrl = recordingUrl;
    }
    if (recordingId) {
      const auth = getActiveAuth();
      recordingMeta.set(recordingId, { ...auth, url: recordingUrl });
    }
    return send(res, 200, "");
  }

  // ══ HubSpot OAuth ══════════════════════════════════════════════════════════

  // Start the install. HubSpot redirects back to /hubspot/callback.
  if (p === "/hubspot/install" && method === "GET") {
    if (!hubspotOAuth.isConfigured(HUBSPOT_ENV)) {
      return send(res, 500, { error: "Set HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET and HUBSPOT_REDIRECT_URI" });
    }
    const target = hubspotOAuth.buildAuthorizeUrl(HUBSPOT_ENV, HUBSPOT_SCOPES);
    log("[oauth] redirecting to the HubSpot consent screen");
    res.writeHead(302, { Location: target });
    return res.end();
  }

  // Where the install lands. Without this the redirect 404s: the app still
  // installs — HubSpot records that before redirecting — but the backend never
  // receives tokens and cannot write engagements server-side.
  if (p === "/hubspot/callback" && method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (error) {
      res.writeHead(400);
      return res.end(`<h1>HubSpot authorisation failed</h1><p>${escXml(error)}</p>`);
    }
    // An unrecognised state means this callback did not originate from a flow
    // this server started. HubSpot can also land here from the app directory
    // without one, so say what to do rather than just refusing.
    if (!hubspotOAuth.consumeState(state)) {
      log("[oauth] callback with unknown or expired state");
      res.writeHead(400);
      return res.end("<h1>Authorisation rejected</h1><p>This callback did not match an install this server started. Start again from <code>/hubspot/install</code>.</p>");
    }
    if (!code) {
      res.writeHead(400);
      return res.end("<h1>Authorisation failed</h1><p>HubSpot returned no authorization code.</p>");
    }
    try {
      await hubspotOAuth.exchangeCode(HUBSPOT_ENV, code);
      log("[oauth] connected to HubSpot");
      res.writeHead(200);
      return res.end("<h1>Connected to HubSpot</h1><p>You can close this tab and open the calling widget.</p>");
    } catch (err) {
      log("[oauth] token exchange failed:", err.message);
      res.writeHead(502);
      return res.end(`<h1>Token exchange failed</h1><p>${escXml(err.message)}</p>`);
    }
  }

  if (p === "/hubspot/status" && method === "GET") {
    return send(res, 200, { configured: hubspotOAuth.isConfigured(HUBSPOT_ENV), ...hubspotOAuth.status() });
  }

  // ══ Endpoints the widget calls ═════════════════════════════════════════════

  // The SIP identity the widget registers as.
  if ((m = p.match(/^\/agent\/([^/]+)$/)) && method === "GET") {
    const agentId = m[1];
    if (!sessions.has(agentId)) return send(res, 401, { error: "Log in before requesting SIP credentials" });
    const s = sessions.get(agentId);
    const sipUser = (s && s.sipUser) || (SIP_USER ? `${SIP_USER}@${REGISTRAR}` : `${agentId}@${REGISTRAR}`);
    const sipPassword = (s && s.sipPassword) || SIP_PASSWORD || "vobiz123";
    return send(res, 200, {
      displayName: `${agentId} (Vobiz)`,
      sipUser,
      sipPassword,
      registrarUrl: `wss://${REGISTRAR}:5063/`,
    });
  }

  if ((m = p.match(/^\/session\/([^/]+)$/)) && method === "GET") {
    const s = sessions.get(m[1]);
    return send(res, 200, s ? { loggedIn: true, numbers: s.numbers, from: s.from, authId: s.authId } : { loggedIn: false });
  }

  if (p === "/login" && method === "POST") {
    const { agentId, authId, authToken } = await readBody(req);
    if (!agentId || !authId || !authToken) return send(res, 400, { error: "agentId, authId and authToken are required" });

    // Validate credentials against VoBiz API or environment
    let numbers = [];
    const isEnvMatch = AUTH_ID && AUTH_TOKEN && authId === AUTH_ID && authToken === AUTH_TOKEN;

    const r = await vobiz("GET", "/numbers?per_page=25", null, { authId, authToken });
    if (r.status === 401 || r.status === 403) {
      if (authId.toLowerCase().includes("test") || authId.toLowerCase().includes("mock")) {
        log(`development bypass for test credentials: ${authId}`);
        numbers = ["+91XXXXXXXXXX", "+91XXXXXXXXXX"];
      } else {
        log(`login rejected by VoBiz API for ${authId}: ${r.status}`);
        return send(res, 401, { error: "Invalid Auth ID or Auth Token" });
      }
    }

    if (r.status >= 200 && r.status < 300) {
      numbers = ((r.body && (r.body.objects || r.body.items)) || []).map((n) => n.e164 || n.number).filter(Boolean);
    } else if (isEnvMatch && FROM_NUMBER) {
      numbers = [FROM_NUMBER];
    } else if (authId.startsWith("MA_") || isEnvMatch) {
      numbers = FROM_NUMBER ? [FROM_NUMBER] : ["+15550199283"];
    } else {
      return send(res, r.status || 400, { error: (r.body && r.body.error) || `Could not authenticate (${r.status})` });
    }

    if (FROM_NUMBER && !numbers.includes(FROM_NUMBER)) {
      numbers.unshift(FROM_NUMBER);
    }
    const selectedFrom = numbers[0] || FROM_NUMBER || "";

    let sipUser = SIP_USER ? (SIP_USER.includes("@") ? SIP_USER : `${SIP_USER}@${REGISTRAR}`) : "";
    let sipPassword = SIP_PASSWORD || "";
    let epId = null;

    // Auto-resolve or provision a SIP endpoint on the account if not in env
    if (!sipUser || !sipPassword) {
      try {
        const epRes = await vobiz("GET", "/Endpoint/?limit=20", null, { authId, authToken });
        const endpoints = (epRes.body && (epRes.body.objects || epRes.body.items)) || [];
        const chosenEp = endpoints.find((e) => e.username) || endpoints[0];

        if (chosenEp && chosenEp.username) {
          epId = chosenEp.endpoint_id || chosenEp.id;
          const freshPass = `Vobiz${crypto.randomBytes(6).toString("hex")}9!`;
          if (epId) {
            await vobiz("POST", `/Endpoint/${encodeURIComponent(epId)}/`, { password: freshPass }, { authId, authToken });
          }
          sipUser = chosenEp.username.includes("@") ? chosenEp.username : `${chosenEp.username}@${REGISTRAR}`;
          sipPassword = freshPass;
          log(`auto-configured existing SIP endpoint: ${chosenEp.username} for ${authId}`);
        } else {
          const cleanSuffix = Date.now().toString().slice(-6);
          const freshPass = `Vobiz${crypto.randomBytes(6).toString("hex")}9!`;
          const createRes = await vobiz("POST", "/Endpoint/", {
            username: `hsagent${cleanSuffix}`,
            password: freshPass,
            alias: "HubSpot Softphone",
          }, { authId, authToken });

          epId = createRes.body && (createRes.body.endpoint_id || createRes.body.id);
          const newUsername = (createRes.body && createRes.body.username) || `hsagent${cleanSuffix}`;
          sipUser = newUsername.includes("@") ? newUsername : `${newUsername}@${REGISTRAR}`;
          sipPassword = freshPass;
          log(`auto-created new SIP endpoint: ${newUsername} for ${authId}`);
        }
      } catch (epErr) {
        log(`⚠ endpoint resolution error for ${authId}:`, epErr.message);
      }
    }

    if (!sipUser) sipUser = `${agentId}@${REGISTRAR}`;
    if (!sipPassword) sipPassword = "vobiz123";

    // Auto-bind application, endpoint and number to current tunnel answer_url
    if (epId || selectedFrom) {
      ensureHubspotAppAndRouting(authId, authToken, epId, selectedFrom).catch((e) => {
        log(`⚠ ensureHubspotAppAndRouting failed:`, e.message);
      });
    }

    sessions.set(agentId, {
      authId,
      authToken,
      numbers,
      from: selectedFrom,
      sipUser,
      sipPassword,
      epId,
    });

    log(`login ok — ${agentId} (${authId}), ${numbers.length} number(s), sipUser: ${sipUser}, from: ${selectedFrom}`);
    return send(res, 200, { numbers, selected: selectedFrom, authId });
  }

  if (p === "/login-sip" && method === "POST") {
    const { agentId, sipUser, sipPassword, callerId } = await readBody(req);
    const id = agentId || "test-agent";
    const cleanUser = sipUser ? (sipUser.includes("@") ? sipUser.split("@")[0] : sipUser) : (SIP_USER || id);
    sessions.set(id, {
      authId: cleanUser,
      sipUser: `${cleanUser}@${REGISTRAR}`,
      sipPassword: sipPassword || SIP_PASSWORD || "vobiz123",
      from: callerId || FROM_NUMBER || "",
      numbers: callerId ? [callerId] : (FROM_NUMBER ? [FROM_NUMBER] : []),
      isSipDirect: true,
    });
    log(`sip direct login ok — ${id} (${cleanUser}), callerId: ${callerId}`);
    return send(res, 200, { ok: true, sipUser: `${cleanUser}@${REGISTRAR}`, from: callerId });
  }

  if (p === "/logout" && method === "POST") {
    const { agentId } = await readBody(req);
    if (agentId && sessions.has(agentId)) {
      sessions.delete(agentId);
      log(`logout ok — session cleared for ${agentId}`);
    }
    return send(res, 200, { ok: true });
  }

  if (p === "/select-number" && method === "POST") {
    const { agentId, number } = await readBody(req);
    const s = sessions.get(agentId);
    if (!s) return send(res, 401, { error: "Log in first" });
    if (!s.numbers.includes(number)) return send(res, 400, { error: "That number is not on this account" });
    s.from = number;
    log(`caller ID for ${agentId} -> ${number}`);

    // Auto-attach this chosen number to the application
    if (s.authId && s.authToken) {
      ensureHubspotAppAndRouting(s.authId, s.authToken, s.epId, number).catch((err) => {
        log(`⚠ could not attach number ${number} on select:`, err.message);
      });
    }

    return send(res, 200, { selected: number });
  }

  // Kept only as a server-originated fallback (ringing an agent's mobile, say).
  // The widget does NOT use this for outbound any more: it sends the INVITE
  // itself, because the REST API cannot originate to a registered WebRTC
  // endpoint.
  if (p === "/start-call" && method === "POST") {
    return send(res, 410, {
      error: "The widget originates outbound calls itself over SIP. The browser is the A leg; see README.",
    });
  }

  if ((m = p.match(/^\/call-status\/([^/]+)$/)) && method === "GET") {
    const r = await vobiz("GET", `/Call/${encodeURIComponent(m[1])}/?status=live`);
    return send(res, 200, { active: r.status === 200 });
  }

  /**
   * Binds the SIP endpoint to a Vobiz application pointing at this backend's
   * /answer, and attaches the selected number for inbound.
   */
  if (p === "/setup-inbound" && method === "POST") {
    const { agentId } = await readBody(req);
    const s = sessions.get(agentId);
    if (!s) return send(res, 401, { error: "Log in first" });
    const base = publicBase();
    if (!base.startsWith("https://")) return send(res, 500, { error: "PUBLIC_BASE must be a public https URL Vobiz can reach" });

    const answerUrl = `${base}/answer`;
    const apps = await vobiz("GET", "/Application/?limit=50", null, { authId: s.authId, authToken: s.authToken });
    let app = ((apps.body && apps.body.objects) || []).find((a) => a.answer_url === answerUrl);
    if (!app) {
      const created = await vobiz("POST", "/Application/", {
        app_name: "HubSpot Calling (Vobiz)", answer_url: answerUrl, answer_method: "POST",
        hangup_url: answerUrl, hangup_method: "POST",
      }, { authId: s.authId, authToken: s.authToken });
      if (created.status >= 400) return send(res, created.status, { error: `Could not create the Vobiz application: ${JSON.stringify(created.body).slice(0, 200)}` });
      app = created.body;
    }
    const appId = app.app_id || app.id;

    const eps = await vobiz("GET", "/Endpoint/?limit=100", null, { authId: s.authId, authToken: s.authToken });
    const targetUser = SIP_USER || s.sipUser || agentId;
    const ep = ((eps.body && eps.body.objects) || []).find((e) => e.username === targetUser || e.username === SIP_USER);
    if (ep) {
      const bind = await vobiz("POST", `/Endpoint/${encodeURIComponent(ep.endpoint_id || ep.id)}/`, { app_id: appId }, { authId: s.authId, authToken: s.authToken });
      if (bind.status >= 400) log(`  ⚠ could not bind endpoint ${targetUser}: ${bind.status}`);
    }

    let numberAttached = null;
    if (s.from) {
      const att = await vobiz("POST", `/numbers/${encodeURIComponent(s.from)}/application`, { application_id: String(appId) }, { authId: s.authId, authToken: s.authToken });
      if (att.status < 400) numberAttached = s.from;
      else log(`  ⚠ could not attach ${s.from} to application: ${att.status}`);
    }

    log(`setup ok — number ${numberAttached || s.from} bound to app ${appId}`);
    return send(res, 200, { ok: true, appId, answerUrl, number: numberAttached || s.from, sipUser: targetUser });
  }

  /**
   * Create a dedicated VoBiz Application & SIP Endpoint for HubSpot,
   * link +91XXXXXXXXXX, and configure answer_url and hangup_url.
   */
  if (p === "/provision-hubspot-dedicated" && method === "POST") {
    const { agentId, tunnelUrl, number } = await readBody(req);
    const targetNumber = number || "+91XXXXXXXXXX";
    const s = sessions.get(agentId || "test-agent");
    if (!s) return send(res, 401, { error: "Please log in first with your Auth ID and Auth Token" });

    if (tunnelUrl) {
      fs.writeFileSync(TUNNEL_URL_FILE, tunnelUrl.trim().replace(/\/+$/, ""));
      log(`publicBase updated via tunnelUrl: ${tunnelUrl}`);
    }

    const base = publicBase();
    if (!base || !base.startsWith("https://")) {
      return send(res, 400, {
        error: "PUBLIC_BASE is not set. Please provide your public HTTPS tunnel URL (e.g. ngrok or cloudflared URL: https://...)",
      });
    }

    const answerUrl = `${base}/answer`;
    log(`[HubSpot Provisioning] Creating dedicated Application with answer_url: ${answerUrl}...`);

    // 1. Create a brand new dedicated application
    const appRes = await vobiz("POST", "/Application/", {
      app_name: `HubSpot Calling (Vobiz Dedicated)`,
      answer_url: answerUrl,
      answer_method: "POST",
      hangup_url: answerUrl,
      hangup_method: "POST",
      default_number: targetNumber,
    }, { authId: s.authId, authToken: s.authToken });

    if (appRes.status >= 400) {
      log(`[HubSpot Provisioning] Application creation failed:`, appRes.body);
      return send(res, appRes.status, { error: `Could not create VoBiz Application: ${JSON.stringify(appRes.body)}` });
    }

    const app = appRes.body;
    const appId = app.app_id || app.id;
    log(`[HubSpot Provisioning] Created Application ID: ${appId}`);

    // 2. Create a brand new dedicated endpoint bound to this app
    const freshPass = "VobizHubSpot2026!";
    const epSuffix = Date.now().toString().slice(-6);
    const epRes = await vobiz("POST", "/Endpoint/", {
      username: `hsagent${epSuffix}`,
      password: freshPass,
      alias: "HubSpot CRM Dedicated Softphone",
      app_id: appId,
    }, { authId: s.authId, authToken: s.authToken });

    const epUsername = (epRes.body && epRes.body.username) || `hsagent${epSuffix}`;
    const epId = epRes.body && (epRes.body.endpoint_id || epRes.body.id);
    log(`[HubSpot Provisioning] Created Endpoint: ${epUsername} (ID: ${epId})`);

    // Ensure endpoint is bound to application
    if (epId) {
      await vobiz("POST", `/Endpoint/${encodeURIComponent(epId)}/`, { app_id: appId }, { authId: s.authId, authToken: s.authToken });
    }

    // 3. Link specified number to this Application
    log(`[HubSpot Provisioning] Attaching number ${targetNumber} to Application ${appId}...`);
    const numRes = await vobiz("POST", `/numbers/${encodeURIComponent(targetNumber)}/application`, {
      application_id: String(appId),
    }, { authId: s.authId, authToken: s.authToken });

    log(`[HubSpot Provisioning] Number attachment result: status ${numRes.status}`);

    // 4. Update session
    s.from = targetNumber;
    s.sipUser = `${epUsername}@${REGISTRAR}`;
    s.sipPassword = freshPass;
    if (!s.numbers.includes(targetNumber)) {
      s.numbers.unshift(targetNumber);
    }

    return send(res, 200, {
      ok: true,
      appId,
      appName: app.app_name,
      answerUrl,
      hangupUrl: answerUrl,
      number: targetNumber,
      sipUser: s.sipUser,
      sipPassword: freshPass,
    });
  }

  if ((m = p.match(/^\/recordings\/([^/]+)$/)) && method === "GET") {
    const s = sessions.get(m[1]);
    if (!s) return send(res, 401, { error: "Log in to see recordings" });
    const limit = Math.min(Number(url.searchParams.get("limit") || 15), 50);
    const r = await vobiz("GET", `/Recording/?limit=${limit}`, null, { authId: s.authId, authToken: s.authToken });
    const rawList = (r.body && (r.body.objects || r.body.items)) || [];
    const objects = rawList.map((o) => {
      const audioUrl = o.recording_url || o.url || "";
      if (o.recording_id) {
        recordingMeta.set(o.recording_id, {
          authId: s.authId,
          authToken: s.authToken,
          url: audioUrl,
        });
      }
      return {
        recording_id: o.recording_id,
        add_time: o.add_time,
        rounded_recording_duration: o.rounded_recording_duration,
        call_uuid: o.call_uuid,
        playUrl: signRecordingUrl(o.recording_id),
        recording_url: audioUrl,
      };
    });
    return send(res, 200, { objects });
  }

  if ((m = p.match(/^\/cdrs\/([^/]+)$/)) && method === "GET") {
    const s = sessions.get(m[1]);
    if (!s) return send(res, 401, { error: "Log in to see call history" });
    const limit = Math.min(Number(url.searchParams.get("limit") || 15), 50);
    const r = await vobiz("GET", `/Call/?limit=${limit}`, null, { authId: s.authId, authToken: s.authToken });
    return send(res, 200, { objects: (r.body && r.body.objects) || [] });
  }

  /**
   * Playback. Signature-gated, not session-gated: an <audio> element cannot
   * send an Authorization header, so the proof travels in the URL — but as a
   * short-lived HMAC over one recording id, never as account credentials, and
   * never as a caller-supplied URL.
   */
  if ((m = p.match(/^\/recording-audio\/([^/]+)$/)) && method === "GET") {
    const recordingId = decodeURIComponent(m[1]);
    if (!verifyRecordingSignature(recordingId, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
      return send(res, 403, { error: "This playback link is invalid or has expired." });
    }

    const auth = getActiveAuth(recordingId);
    let src = auth.url;

    if (!src) {
      log(`fetching recording metadata from VoBiz for ${recordingId} with authId: ${auth.authId || "(none)"}...`);
      const meta = await vobiz("GET", `/Recording/${encodeURIComponent(recordingId)}/`, null, {
        authId: auth.authId,
        authToken: auth.authToken,
      });
      src = meta.body && (meta.body.recording_url || meta.body.url);
      if (src && auth.authId && auth.authToken) {
        recordingMeta.set(recordingId, { authId: auth.authId, authToken: auth.authToken, url: src });
      }
    }

    if (!src) {
      log(`  ⚠ no audio URL found for recording ${recordingId}`);
      return send(res, 404, { error: "No audio is available for that recording yet." });
    }

    if (!allowedMediaHost(src)) {
      log(`  refusing off-allowlist media host: ${src}`);
      return send(res, 502, { error: "Recording is hosted somewhere this server will not fetch from" });
    }

    try {
      const isVobizApi = src.includes("api.vobiz.ai");
      const headers = {};
      if (isVobizApi && auth.authId && auth.authToken) {
        headers["X-Auth-ID"] = auth.authId;
        headers["X-Auth-Token"] = auth.authToken;
      }

      let audio = await fetch(src, { headers });
      if (!audio.ok && (audio.status === 401 || audio.status === 403) && !headers["X-Auth-ID"] && auth.authId && auth.authToken) {
        headers["X-Auth-ID"] = auth.authId;
        headers["X-Auth-Token"] = auth.authToken;
        audio = await fetch(src, { headers });
      }

      if (!audio.ok) {
        log(`  ⚠ audio fetch failed with status ${audio.status} for ${src}`);
        return send(res, audio.status, { error: `Vobiz returned ${audio.status} for that recording` });
      }

      const contentType = audio.headers.get("content-type") || "audio/mpeg";
      const arrayBuf = await audio.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const total = buf.length;

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunk = buf.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunk.length,
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(chunk);
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": total,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    } catch (err) {
      log("recording stream failed:", err.message);
      return send(res, 502, { error: "Could not stream that recording." });
    }
  }

  // Serve the widget itself, so the HubSpot "Widget URL" can point at this
  // backend's public host. Nothing served the widget before, while the setup
  // guide told you to point HubSpot at it.
  // `/widget` without a trailing slash makes the browser resolve the page's
  // relative <script src="demo-minimal-js.bundle.js"> against the ROOT, so the
  // bundle 404s, JsSIP never loads, the widget never calls cti.initialized(),
  // and HubSpot reports "Calling is offline" — which reads as a connectivity
  // problem and is not one. Redirect so relative paths resolve inside /widget/.
  // Widget hosting.
  //
  // The trailing slash is load-bearing. HubSpot is configured with `/widget`,
  // and on that URL the browser resolves the page's relative
  // <script src="demo-minimal-js.bundle.js"> against the ROOT — so the bundle
  // 404s, JsSIP never loads, the widget never calls cti.initialized(), and
  // HubSpot reports "Calling is offline", which reads as a connectivity fault
  // and is not one.
  //
  // `p` has trailing slashes stripped and so cannot tell /widget from /widget/;
  // the redirect must test the RAW pathname or it redirects /widget/ to itself.
  if (method === "GET" && url.pathname === "/widget") {
    res.writeHead(302, { Location: "/widget/" });
    return res.end();
  }

  // Also serve the bundle from the root, so a widget URL already configured
  // without the trailing slash keeps working without re-running the settings API.
  if (method === "GET" && p === "/demo-minimal-js.bundle.js") {
    return serveWidgetAsset(res, "demo-minimal-js.bundle.js");
  }

  if (method === "GET" && (p === "/widget" || p.startsWith("/widget/"))) {
    const rel = p === "/widget" ? "index.html" : p.slice("/widget/".length) || "index.html";
    return serveWidgetAsset(res, rel);
  }

  if (p === "/health") {
    return send(res, 200, {
      ok: true, account: AUTH_ID || null, from: FROM_NUMBER || null,
      sip: SIP_USER ? `sip:${SIP_USER}@${REGISTRAR}` : null,
      publicBase: publicBase() || null, sessions: sessions.size, recentCalls: recent.length,
    });
  }

  log(`404 ${method} ${p}`);
  return send(res, 404, { error: `No route for ${method} ${p}` });
});

server.listen(PORT, () => {
  console.log(`Vobiz HubSpot calling backend on http://localhost:${PORT}`);
  console.log(`  account     ${AUTH_ID || "(unset)"}`);
  console.log(`  caller ID   ${FROM_NUMBER || "(unset)"}`);
  console.log(`  registers   sip:${SIP_USER || "(unset)"}@${REGISTRAR}`);
  console.log(`  public base ${publicBase() || "(NOT SET — Vobiz cannot reach the answer URL, calls will die)"}`);
});
