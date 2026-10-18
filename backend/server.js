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

// process.loadEnvFile needs Node 20.12+. On older Node it is undefined, and a
// bare try/catch would swallow that and run with no configuration at all.
if (typeof process.loadEnvFile !== "function") {
  console.error("Node 20.12 or newer is required (process.loadEnvFile). Found " + process.version);
  process.exit(1);
}
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch { /* no .env: env may come from the shell */ }

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

// Single-endpoint mode: set VOBIZ_SIP_USER and VOBIZ_SIP_PASSWORD and every
// agent registers as that one endpoint. Only correct for ONE agent — two
// browsers registered as the same endpoint race for every inbound call.
// Leave both empty and each agent gets an endpoint of their own.
const SHARED_SIP = Boolean(SIP_USER && SIP_PASSWORD);
const SESSION_TTL_MS = Number(clean(process.env.SESSION_TTL_HOURS) || 12) * 3600 * 1000;
const ENDPOINT_STORE = clean(process.env.AGENT_ENDPOINT_STORE) || path.join(__dirname, "agent-endpoints.json");

for (const [k, v] of Object.entries({ VOBIZ_AUTH_ID: AUTH_ID, VOBIZ_AUTH_TOKEN: AUTH_TOKEN, VOBIZ_FROM_NUMBER: FROM_NUMBER })) {
  if (!v) log(`⚠  ${k} is not set.`);
}
if (SIP_USER && !SIP_PASSWORD) log("⚠  VOBIZ_SIP_USER is set without VOBIZ_SIP_PASSWORD — ignoring it; agents get their own endpoints.");
log(SHARED_SIP
  ? `SIP mode: shared endpoint ${SIP_USER} (single agent only)`
  : "SIP mode: one endpoint per agent, created on first sign-in");

// ─── state ───────────────────────────────────────────────────────────────────
// Session token -> { kind, agentId, authId, authToken, numbers, from, sipUser,
// sipPassword, epId, createdAt }. The token is the only thing that proves who
// is calling: agentId is chosen by the browser and is a lookup key, never a
// credential.
const sessions = new Map();
// `${kind}:${authId}:${agentId}` -> token, so signing in again replaces the old session.
const sessionByAgent = new Map();

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function liveSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) dropSession(token);
  }
  return [...sessions.values()];
}

function openSession(data) {
  const key = `${data.kind}:${data.authId}:${data.agentId}`;
  const previous = sessionByAgent.get(key);
  if (previous) sessions.delete(previous);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...data, createdAt: Date.now() });
  sessionByAgent.set(key, token);
  return token;
}

function dropSession(token) {
  const s = sessions.get(token);
  if (!s) return;
  sessions.delete(token);
  const key = `${s.kind}:${s.authId}:${s.agentId}`;
  if (sessionByAgent.get(key) === token) sessionByAgent.delete(key);
}

function sessionFrom(req) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || "");
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { dropSession(m[1]); return null; }
  return { token: m[1], ...s, ref: s };
}

const sipUserPart = (v) => String(v || "").replace(/^sips?:/, "").split("@")[0];
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
    // http is accepted only so the test suite can stand in a fake Vobiz API.
    const base = new URL(API_BASE);
    const transport = base.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port || undefined,
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

// ─── per-agent SIP endpoints ─────────────────────────────────────────────────
// One Vobiz endpoint per (account, agent). The mapping agent -> endpoint id is
// persisted so a restart reuses the same endpoint instead of minting a new one;
// the SIP password is NOT persisted. Each sign-in sets a fresh random password
// on the agent's own endpoint and hands it to that agent's browser only.
function loadEndpointStore() {
  try { return JSON.parse(fs.readFileSync(ENDPOINT_STORE, "utf8")) || {}; } catch { return {}; }
}

function saveEndpointStore(store) {
  const tmp = `${ENDPOINT_STORE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ENDPOINT_STORE);
}

const freshSipPassword = () => `Vobiz${crypto.randomBytes(12).toString("hex")}9!`;

const inflightEndpoints = new Map();

/**
 * Find or create the endpoint that belongs to this agent, set a new password on
 * it, and return the identity the agent's browser registers as.
 *
 * POST /Endpoint/ rewrites the submitted username (send "hsagent", get
 * "hsagent1187694299…" back), and the create response does not reliably carry
 * the stored name — so the username is always read back with a GET.
 */
function ensureAgentEndpoint(auth, agentId) {
  const key = `${auth.authId}:${agentId}`;
  if (inflightEndpoints.has(key)) return inflightEndpoints.get(key);
  const work = (async () => {
    const store = loadEndpointStore();
    let entry = store[key] || null;
    let username = null;
    const password = freshSipPassword();

    if (entry) {
      const got = await vobiz("GET", `/Endpoint/${encodeURIComponent(entry.endpointId)}/`, null, auth);
      if (got.status === 404) {
        log(`endpoint ${entry.endpointId} for ${agentId} no longer exists; creating a new one`);
        delete store[key];
        entry = null;
      } else if (got.status >= 200 && got.status < 300 && got.body && got.body.username) {
        username = got.body.username;
        const upd = await vobiz("POST", `/Endpoint/${encodeURIComponent(entry.endpointId)}/`, { password }, auth);
        if (upd.status >= 400) throw new Error(`Vobiz returned ${upd.status} setting the SIP password for ${agentId}`);
      } else {
        throw new Error(`Vobiz returned ${got.status} reading endpoint ${entry.endpointId}`);
      }
    }

    if (!entry) {
      const slug = agentId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "agent";
      const created = await vobiz("POST", "/Endpoint/", {
        username: `hs${slug}${crypto.randomBytes(3).toString("hex")}`,
        password,
        alias: `hubspot-${agentId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
      }, auth);
      const endpointId = created.body && (created.body.endpoint_id || created.body.id);
      if (created.status >= 400 || !endpointId) {
        throw new Error(`Vobiz returned ${created.status} creating an endpoint for ${agentId}`);
      }
      const got = await vobiz("GET", `/Endpoint/${encodeURIComponent(endpointId)}/`, null, auth);
      username = (got.body && got.body.username) || sipUserPart(created.body.sip_uri) || null;
      if (!username) throw new Error(`Could not read back the stored username of endpoint ${endpointId}`);
      entry = { endpointId: String(endpointId), username, createdAt: new Date().toISOString() };
      store[key] = entry;
      saveEndpointStore(store);
      log(`created endpoint ${username} (${endpointId}) for agent ${agentId}`);
    } else if (username !== entry.username) {
      store[key] = { ...entry, username };
      saveEndpointStore(store);
    }

    return { epId: String(entry.endpointId), sipUser: `${username}@${REGISTRAR}`, sipPassword: password };
  })();
  inflightEndpoints.set(key, work);
  return work.finally(() => inflightEndpoints.delete(key));
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
    return p.protocol === "https:" && MEDIA_HOSTS.some((re) => re.test(p.hostname));
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
];
// Not a quick-tunnel suffix (Cloudflare, ngrok): anyone can mint a host there in
// seconds, so allowing the suffix is the same as allowing every origin. This
// backend's own public origin is allowed, because it serves the widget.
const EXTRA_ORIGINS = clean(process.env.ALLOWED_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin;
  let own = "";
  try { own = publicBase() ? new URL(publicBase()).origin : ""; } catch { /* unset */ }
  if (origin && (origin === own || EXTRA_ORIGINS.includes(origin) || ORIGIN_ALLOWLIST.some((re) => re.test(origin)))) {
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
    log("  ⚠ cannot configure Vobiz Application: PUBLIC_BASE is not an https URL");
    return null;
  }
  const answerUrl = `${base}/answer`;
  try {
    const apps = await vobiz("GET", "/Application/?limit=50", null, { authId, authToken });
    const appList = (apps.body && (apps.body.objects || apps.body.items)) || [];
    // Only ever an application this integration created. Falling back to the
    // account's first application rewrote the answer_url of whatever else the
    // customer runs on Vobiz.
    let app = appList.find((a) => a.answer_url === answerUrl)
      || appList.find((a) => a.app_name && a.app_name.toLowerCase().includes("hubspot"));
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
      log(`synchronized existing Vobiz Application ${appId} with answerUrl: ${answerUrl}`);
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
      log(`created Vobiz Application: ${appId} with answerUrl: ${answerUrl}`);
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

    const hangup = (why) => {
      log(`  -> ${why}; hanging up`);
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>`);
    };

    if (fromBrowser) {
      // Outbound. The SIP From user is the agent's own endpoint, which is how
      // the caller ID that agent picked is found.
      const fromUser = sipUserPart(from);
      const s = liveSessions().find((x) => sipUserPart(x.sipUser) === fromUser);
      const callerId = (s && s.from) || FROM_NUMBER;
      if (!callerId) return hangup(`no caller ID for sip:${fromUser} — sign in, or set VOBIZ_FROM_NUMBER`);
      let dest = to.replace(/[^\d+]/g, "");
      if (dest && !dest.startsWith("+")) dest = `+${dest}`;
      if (!dest) return hangup("no destination number");
      remember({ callUuid, direction: "Outbound", from: callerId, to: dest, startedAt: Date.now() });
      log(`  -> browser is the A leg (${fromUser}${s ? `, agent ${s.agentId}` : ""}), dialling out to ${dest} as ${callerId}`);
      return send(res, 200,
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${record}\n  <Dial ${attrs(callerId)}>\n    <Number>${escXml(dest)}</Number>\n  </Dial>\n</Response>`);
    }

    // Inbound PSTN. callerId must be a number this account owns — omit it and
    // Vobiz derives it from the A leg, which here is the *caller's* number, so
    // B-leg creation is refused silently and the browser never rings.
    //
    // Ring every signed-in agent who can take calls on the dialled number,
    // simultaneously: sibling <User> children, first to answer wins. If no
    // session claims the number, ring every signed-in agent on this account.
    const dialedNumber = toE164(to);
    const live = liveSessions().filter((x) => !AUTH_ID || x.authId === AUTH_ID);
    let ringing = live.filter((x) => (x.numbers || []).includes(dialedNumber) || x.from === dialedNumber);
    if (!ringing.length) ringing = live;
    const targets = [...new Set(ringing.map((x) => x.sipUser).filter(Boolean).map((u) => (u.includes("@") ? u : `${u}@${REGISTRAR}`).replace(/^sips?:/, "")))];
    if (!targets.length && SHARED_SIP) targets.push(SIP_USER.includes("@") ? SIP_USER : `${SIP_USER}@${REGISTRAR}`);
    const callerId = dialedNumber || FROM_NUMBER;
    if (!targets.length) return hangup(`inbound to ${dialedNumber || "(unknown)"} but no agent is signed in`);
    if (!callerId) return hangup("inbound with no dialled number and no VOBIZ_FROM_NUMBER");
    remember({ callUuid, direction: "Inbound", from, to: callerId, startedAt: Date.now() });
    log(`  -> inbound from ${from}, ringing ${targets.map((t) => `sip:${t}`).join(", ")} callerId=${callerId}`);
    const users = targets.map((t) => `    <User>sip:${escXml(t)}</User>`).join("\n");
    return send(res, 200,
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${record}\n  <Dial ${attrs(callerId)}>\n${users}\n  </Dial>\n</Response>`);
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
  // Every one of these except /login and /login-sip needs the session token
  // /login returned, as `Authorization: Bearer <token>`.

  const requireSession = (kinds = ["account", "sip"]) => {
    const s = sessionFrom(req);
    if (!s) { send(res, 401, { error: "Sign in first" }); return null; }
    if (!kinds.includes(s.kind)) { send(res, 403, { error: "Sign in with a Vobiz Auth ID and Auth Token for this" }); return null; }
    return s;
  };

  // The SIP identity the widget registers as: this agent's own endpoint.
  // `/agent/<id>` is accepted for older widgets but must match the session.
  if ((m = p.match(/^\/agent(?:\/([^/]+))?$/)) && method === "GET") {
    const s = requireSession(["account"]);
    if (!s) return;
    if (m[1] && decodeURIComponent(m[1]) !== s.agentId) return send(res, 403, { error: "That is not your agent" });
    return send(res, 200, {
      displayName: `${s.agentId} (Vobiz)`,
      sipUser: s.sipUser,
      sipPassword: s.sipPassword,
      registrarUrl: `wss://${REGISTRAR}:5063/`,
    });
  }

  if ((p === "/session" || p.startsWith("/session/")) && method === "GET") {
    const s = sessionFrom(req);
    return send(res, 200, s
      ? { loggedIn: true, kind: s.kind, agentId: s.agentId, numbers: s.numbers, from: s.from, authId: s.authId, sipUser: s.sipUser }
      : { loggedIn: false });
  }

  if (p === "/login" && method === "POST") {
    const { agentId, authId, authToken } = await readBody(req);
    if (!agentId || !authId || !authToken) return send(res, 400, { error: "agentId, authId and authToken are required" });
    if (!AGENT_ID_RE.test(agentId)) return send(res, 400, { error: "agentId may contain only letters, digits, - and _" });
    if (AUTH_ID && authId !== AUTH_ID) {
      // The caller ID, the application and the balance all belong to the
      // account in .env; a different account's numbers would be refused.
      log(`login rejected — got ${authId}, this backend is bound to ${AUTH_ID}`);
      return send(res, 403, { error: "This backend is configured for a different Vobiz account." });
    }

    // The credentials are checked against Vobiz itself. There is no test or
    // mock bypass: a session here hands out a SIP password billed to the account.
    const r = await vobiz("GET", "/numbers?per_page=25", null, { authId, authToken });
    if (r.status === 401 || r.status === 403) {
      log(`login rejected by Vobiz for ${authId}: ${r.status}`);
      return send(res, 401, { error: "Invalid Auth ID or Auth Token" });
    }
    if (r.status < 200 || r.status >= 300) {
      return send(res, 502, { error: `Vobiz returned ${r.status || "no response"} while checking those credentials` });
    }

    const numbers = ((r.body && (r.body.objects || r.body.items)) || []).map((n) => toE164(n.e164 || n.number)).filter(Boolean);
    if (FROM_NUMBER && authId === AUTH_ID && !numbers.includes(FROM_NUMBER)) numbers.unshift(FROM_NUMBER);
    const selectedFrom = (FROM_NUMBER && numbers.includes(FROM_NUMBER) ? FROM_NUMBER : numbers[0]) || "";

    let sip;
    if (SHARED_SIP) {
      sip = { epId: null, sipUser: SIP_USER.includes("@") ? SIP_USER : `${SIP_USER}@${REGISTRAR}`, sipPassword: SIP_PASSWORD };
    } else {
      try {
        sip = await ensureAgentEndpoint({ authId, authToken }, agentId);
      } catch (err) {
        log(`⚠ could not provision a SIP endpoint for ${agentId}:`, err.message);
        return send(res, 502, { error: `Could not set up a SIP endpoint for this agent: ${err.message}` });
      }
    }

    if (sip.epId || selectedFrom) {
      ensureHubspotAppAndRouting(authId, authToken, sip.epId, selectedFrom).catch((e) => {
        log(`⚠ ensureHubspotAppAndRouting failed:`, e.message);
      });
    }

    const token = openSession({ kind: "account", agentId, authId, authToken, numbers, from: selectedFrom, ...sip });
    log(`login ok — ${agentId} (${authId}), ${numbers.length} number(s), sipUser: ${sip.sipUser}, from: ${selectedFrom}`);
    return send(res, 200, { token, agentId, numbers, selected: selectedFrom, authId, sipUser: sip.sipUser });
  }

  // SIP direct: the browser registers with endpoint credentials the agent typed
  // in. The backend never sees the password. It records which endpoint is this
  // agent's, so outbound gets the right caller ID and inbound rings it — but
  // only after checking, with the account's own credentials, that the endpoint
  // and the caller ID really belong to the account.
  if (p === "/login-sip" && method === "POST") {
    const { agentId, sipUser, callerId } = await readBody(req);
    if (!AUTH_ID || !AUTH_TOKEN) return send(res, 400, { error: "SIP direct sign-in needs VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN on the backend" });
    if (!agentId || !AGENT_ID_RE.test(agentId)) return send(res, 400, { error: "A valid agentId is required" });
    const username = sipUserPart(sipUser);
    const from = toE164(callerId);
    if (!username || !from) return send(res, 400, { error: "sipUser and callerId are required" });

    const eps = await vobiz("GET", "/Endpoint/?limit=100");
    const ep = ((eps.body && (eps.body.objects || eps.body.items)) || []).find((e) => e.username === username);
    if (!ep) return send(res, 403, { error: "That SIP username is not an endpoint on this account" });
    const nums = await vobiz("GET", "/numbers?per_page=100");
    const owned = ((nums.body && (nums.body.objects || nums.body.items)) || []).map((n) => toE164(n.e164 || n.number));
    if (!owned.includes(from)) return send(res, 403, { error: "That caller ID is not a number on this account" });

    const token = openSession({
      kind: "sip", agentId, authId: AUTH_ID, sipUser: `${username}@${REGISTRAR}`,
      epId: ep.endpoint_id || ep.id || null, numbers: [from], from,
    });
    log(`sip direct login ok — ${agentId} (${username}), callerId: ${from}`);
    return send(res, 200, { ok: true, token, sipUser: `${username}@${REGISTRAR}`, from });
  }

  if (p === "/logout" && method === "POST") {
    const s = sessionFrom(req);
    if (s) {
      dropSession(s.token);
      log(`logout ok — session cleared for ${s.agentId}`);
    }
    return send(res, 200, { ok: true });
  }

  if (p === "/select-number" && method === "POST") {
    const s = requireSession(["account"]);
    if (!s) return;
    const { number } = await readBody(req);
    if (!s.numbers.includes(number)) return send(res, 400, { error: "That number is not on this account" });
    s.ref.from = number;
    log(`caller ID for ${s.agentId} -> ${number}`);
    ensureHubspotAppAndRouting(s.authId, s.authToken, s.epId, number).catch((err) => {
      log(`⚠ could not attach number ${number} on select:`, err.message);
    });
    return send(res, 200, { selected: number });
  }

  // The widget originates outbound calls itself: the REST API cannot originate
  // to a registered WebRTC endpoint.
  if (p === "/start-call" && method === "POST") {
    return send(res, 410, {
      error: "The widget originates outbound calls itself over SIP. The browser is the A leg; see README.",
    });
  }

  if ((m = p.match(/^\/call-status\/([^/]+)$/)) && method === "GET") {
    const s = requireSession(["account"]);
    if (!s) return;
    const r = await vobiz("GET", `/Call/${encodeURIComponent(m[1])}/?status=live`, null, { authId: s.authId, authToken: s.authToken });
    return send(res, 200, { active: r.status === 200 });
  }

  /**
   * Points a Vobiz application at this backend's /answer, binds this agent's
   * endpoint to it, and attaches the selected number for inbound.
   */
  if (p === "/setup-inbound" && method === "POST") {
    const s = requireSession(["account"]);
    if (!s) return;
    const base = publicBase();
    if (!base.startsWith("https://")) return send(res, 500, { error: "PUBLIC_BASE must be a public https URL Vobiz can reach" });
    const appId = await ensureHubspotAppAndRouting(s.authId, s.authToken, s.epId, s.from);
    if (!appId) return send(res, 502, { error: "Could not create or update the Vobiz application" });
    log(`setup ok — number ${s.from} bound to app ${appId}`);
    return send(res, 200, { ok: true, appId, answerUrl: `${base}/answer`, number: s.from, sipUser: s.sipUser });
  }

  /**
   * Create a dedicated Vobiz application for HubSpot, bind this agent's
   * endpoint to it, and attach a number the account owns.
   */
  if (p === "/provision-hubspot-dedicated" && method === "POST") {
    const s = requireSession(["account"]);
    if (!s) return;
    const { tunnelUrl, number } = await readBody(req);
    const targetNumber = toE164(number);
    if (!targetNumber || !s.numbers.includes(targetNumber)) {
      return send(res, 400, { error: "Choose a number that is on this Vobiz account" });
    }
    if (tunnelUrl) {
      let u;
      try { u = new URL(String(tunnelUrl).trim()); } catch { /* invalid */ }
      if (!u || u.protocol !== "https:" || u.pathname.replace(/\/+$/, "") !== "") {
        return send(res, 400, { error: "The tunnel URL must be a bare https origin, e.g. https://your-host.example.com" });
      }
      fs.writeFileSync(TUNNEL_URL_FILE, u.origin);
      log(`publicBase updated by ${s.agentId}: ${u.origin}`);
    }
    const base = publicBase();
    if (!base.startsWith("https://")) {
      return send(res, 400, { error: "PUBLIC_BASE is not set. Provide your public HTTPS tunnel URL." });
    }

    const answerUrl = `${base}/answer`;
    const appRes = await vobiz("POST", "/Application/", {
      app_name: "HubSpot Calling (Vobiz Dedicated)",
      answer_url: answerUrl, answer_method: "POST",
      hangup_url: answerUrl, hangup_method: "POST",
      default_number: targetNumber,
    }, { authId: s.authId, authToken: s.authToken });
    const appId = appRes.body && (appRes.body.app_id || appRes.body.id);
    if (appRes.status >= 400 || !appId) {
      log(`[provision] application creation failed:`, appRes.status);
      return send(res, appRes.status >= 400 ? appRes.status : 502, { error: "Could not create the Vobiz application" });
    }
    if (s.epId) {
      await vobiz("POST", `/Endpoint/${encodeURIComponent(s.epId)}/`, { app_id: appId }, { authId: s.authId, authToken: s.authToken });
    }
    const numRes = await vobiz("POST", `/numbers/${encodeURIComponent(targetNumber)}/application`, {
      application_id: String(appId),
    }, { authId: s.authId, authToken: s.authToken });
    log(`[provision] app ${appId}, endpoint ${s.sipUser}, number ${targetNumber} (attach ${numRes.status})`);
    s.ref.from = targetNumber;
    return send(res, 200, {
      ok: true, appId, appName: (appRes.body && appRes.body.app_name) || "HubSpot Calling (Vobiz Dedicated)",
      answerUrl, hangupUrl: answerUrl, number: targetNumber, sipUser: s.sipUser,
    });
  }

  if ((p === "/recordings" || p.startsWith("/recordings/")) && method === "GET") {
    const s = requireSession(["account"]);
    if (!s) return;
    const limit = Math.min(Number(url.searchParams.get("limit") || 15), 50);
    const r = await vobiz("GET", `/Recording/?limit=${limit}`, null, { authId: s.authId, authToken: s.authToken });
    const rawList = (r.body && (r.body.objects || r.body.items)) || [];
    const objects = rawList.map((o) => {
      const audioUrl = o.recording_url || o.url || "";
      if (o.recording_id) {
        recordingMeta.set(o.recording_id, { authId: s.authId, authToken: s.authToken, url: audioUrl });
      }
      return {
        recording_id: o.recording_id,
        add_time: o.add_time,
        rounded_recording_duration: o.rounded_recording_duration,
        call_uuid: o.call_uuid,
        playUrl: signRecordingUrl(o.recording_id),
      };
    });
    return send(res, 200, { objects });
  }

  if ((p === "/cdrs" || p.startsWith("/cdrs/")) && method === "GET") {
    const s = requireSession(["account"]);
    if (!s) return;
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
      log(`fetching recording metadata from Vobiz for ${recordingId} with authId: ${auth.authId || "(none)"}...`);
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
      // Account credentials go to Vobiz's own hosts and nowhere else. The
      // recording URL can arrive in an unauthenticated webhook, so a bucket
      // host that answers 401 must not get a retry with the Auth Token on it.
      const headers = {};
      if (/(^|\.)vobiz\.ai$/i.test(new URL(src).hostname) && auth.authId && auth.authToken) {
        headers["X-Auth-ID"] = auth.authId;
        headers["X-Auth-Token"] = auth.authToken;
      }

      const audio = await fetch(src, { headers, redirect: "error" });

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
    // No account id or SIP username here: /health is unauthenticated.
    return send(res, 200, {
      ok: true,
      sipMode: SHARED_SIP ? "shared-endpoint" : "per-agent",
      callerIdConfigured: Boolean(FROM_NUMBER),
      publicBase: publicBase() || null, sessions: liveSessions().length, recentCalls: recent.length,
    });
  }

  log(`404 ${method} ${p}`);
  return send(res, 404, { error: `No route for ${method} ${p}` });
});

server.listen(PORT, () => {
  console.log(`Vobiz HubSpot calling backend on http://localhost:${PORT}`);
  console.log(`  account     ${AUTH_ID || "(unset)"}`);
  console.log(`  caller ID   ${FROM_NUMBER || "(unset)"}`);
  console.log(`  SIP         ${SHARED_SIP ? `shared endpoint sip:${SIP_USER}` : "one endpoint per agent"}`);
  console.log(`  public base ${publicBase() || "(NOT SET — Vobiz cannot reach the answer URL, calls will die)"}`);
});
