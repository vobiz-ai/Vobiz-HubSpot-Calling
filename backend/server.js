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

const APP_ID_RE = /^\d+$/;
const idString = (v) => (v == null || v === "" ? "" : String(v));
// Strict E.164: + then 8-15 digits, no leading zero.
const E164_RE = /^\+[1-9]\d{7,14}$/;

const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");

// Deployment configuration only. Nothing here names a Vobiz account: any
// customer signs in with their own Auth ID + Auth Token from the widget, and
// everything account-specific (endpoints, application, caller IDs) is
// provisioned in THAT account at sign-in.
const PORT = Number(clean(process.env.PORT) || 8092);
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

const SESSION_TTL_MS = Number(clean(process.env.SESSION_TTL_HOURS) || 12) * 3600 * 1000;
const ENDPOINT_STORE = clean(process.env.AGENT_ENDPOINT_STORE) || path.join(__dirname, "agent-endpoints.json");

// The one Vobiz application this integration creates in each account. Only
// letters, digits, - and _ are accepted in app_name. An application is reused
// only if its answer_url is ours or it carries exactly this name — never
// because its name merely mentions HubSpot.
const APP_NAME = "vobiz-hubspot-calling-integration";

for (const k of ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN", "VOBIZ_FROM_NUMBER", "VOBIZ_SIP_USER", "VOBIZ_SIP_PASSWORD"]) {
  if (clean(process.env[k])) log(`⚠  ${k} is set but ignored: agents sign in with their own Vobiz account.`);
}

// ─── state ───────────────────────────────────────────────────────────────────
// authId -> { authToken, numbers, appId }. The ONLY place an account's Auth
// Token lives: memory, never disk, never a response, never a log line. It is
// refreshed on every sign-in, so after a restart an account works again as
// soon as any of its agents signs in.
const accounts = new Map();
const accountAuth = (authId) => {
  const a = accounts.get(authId);
  return a ? { authId, authToken: a.authToken } : null;
};

// Session token -> { agentId, authId, numbers, from, sipUser, sipPassword,
// epId, createdAt }. The token is the only thing that proves who is calling:
// agentId is chosen by the browser and is a lookup key, never a credential.
const sessions = new Map();
// `${authId}:${agentId}` -> token, so signing in again replaces the old session.
const sessionByAgent = new Map();

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function liveSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) dropSession(token);
  }
  return [...sessions.values()];
}

// SIP direct sessions have no account; key them apart from account sessions.
const sessionKey = (d) => (d.kind === "sip" ? `sip:${d.agentId}` : `${d.authId}:${d.agentId}`);

function openSession(data) {
  const key = sessionKey(data);
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
  const key = sessionKey(s);
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

// `${authId}|${recordingId}` -> { authId, url }. No token: the token is looked
// up in `accounts` when the audio is fetched.
const recordingMeta = new Map();
const recKey = (authId, recordingId) => `${authId}|${recordingId}`;

function remember(rec) {
  calls.set(rec.callUuid, rec);
  recent.unshift(rec);
  while (recent.length > 200) {
    const dropped = recent.pop();
    if (dropped) calls.delete(dropped.callUuid);
  }
}

// ─── Vobiz REST ──────────────────────────────────────────────────────────────
// Vobiz ids (app_id in particular) are 17 digits — above
// Number.MAX_SAFE_INTEGER — so a plain JSON.parse silently corrupts any that
// arrive as bare JSON numbers. Quote long integer ids before parsing so they
// stay exact strings end to end.
function parseVobizJson(raw) {
  const safe = String(raw).replace(/("(?:[A-Za-z_]*_id|id|application)"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(safe);
}

/**
 * Call the Vobiz REST API as one account. `auth` is required: there is no
 * backend-wide account to fall back to. A string `body` is sent verbatim (used
 * to splice an exact 17-digit integer into JSON).
 */
function vobiz(method, apiPath, body, auth) {
  if (!auth || !auth.authId || !auth.authToken) {
    return Promise.resolve({ status: 0, body: { error: "no Vobiz credentials for this request" }, raw: "" });
  }
  const currentAuthId = auth.authId;
  const currentAuthToken = auth.authToken;
  return new Promise((resolve) => {
    const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    // http is accepted only so the test suite can stand in a fake Vobiz API.
    const base = new URL(API_BASE);
    const transport = base.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port || undefined,
        method,
        path: `/api/v1/Account/${encodeURIComponent(currentAuthId)}${apiPath}`,
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
          try { parsed = parseVobizJson(raw); } catch { /* keep the raw body */ }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, body: { error: e.message }, raw: "" }));
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

const endpointAlias = (agentId) => `hubspot-${agentId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

async function findEndpointByAlias(auth, alias) {
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await vobiz("GET", `/Endpoint/?limit=100&offset=${offset}`, null, auth);
    if (page.status < 200 || page.status >= 300) return null;
    const objs = (page.body && (page.body.objects || page.body.items)) || [];
    const hit = objs.find((e) => e.alias === alias);
    if (hit) return { id: idString(hit.endpoint_id || hit.id), username: hit.username };
    if (objs.length < 100) return null;
  }
  return null;
}

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

    // Lost the store (new host, wiped data dir)? Reuse the endpoint this
    // integration made for this agent, found by its exact alias.
    if (!entry) {
      const found = await findEndpointByAlias(auth, endpointAlias(agentId));
      if (found && found.username) {
        const upd = await vobiz("POST", `/Endpoint/${encodeURIComponent(found.id)}/`, { password }, auth);
        if (upd.status >= 400) throw new Error(`Vobiz returned ${upd.status} setting the SIP password for ${agentId}`);
        entry = { endpointId: found.id, username: found.username, createdAt: new Date().toISOString() };
        username = found.username;
        store[key] = entry;
        saveEndpointStore(store);
        log(`reusing endpoint ${found.username} (${found.id}) for agent ${agentId}, found by alias`);
      }
    }

    if (!entry) {
      const slug = agentId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "agent";
      const created = await vobiz("POST", "/Endpoint/", {
        username: `hs${slug}${crypto.randomBytes(3).toString("hex")}`,
        password,
        alias: endpointAlias(agentId),
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
// The account id is inside the HMAC payload (and in the URL as `a`), so a
// link minted for one account can never be replayed against another's audio.
const recordingHmac = (authId, recordingId, exp) =>
  crypto.createHmac("sha256", SIGNING_SECRET).update(`${authId}|${recordingId}|${exp}`).digest("hex");

function signRecordingUrl(authId, recordingId) {
  const exp = Math.floor(Date.now() / 1000) + RECORDING_URL_TTL_SECONDS;
  const sig = recordingHmac(authId, recordingId, exp);
  return `${publicBase()}/recording-audio/${encodeURIComponent(recordingId)}?a=${encodeURIComponent(authId)}&exp=${exp}&sig=${sig}`;
}

function verifyRecordingSignature(authId, recordingId, exp, sig) {
  if (!authId || !exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = recordingHmac(authId, recordingId, exp);
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

// Custom X-VH-* SIP headers on the INVITE reach the answer webhook as
// top-level parameters, sometimes prefixed SIPHeader_. Case-insensitive.
function vhParam(params, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(params || {})) {
    const key = k.toLowerCase().replace(/^sipheader_/, "");
    if (key === want && v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

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


/**
 * Find or create this integration's Application in the signed-in account.
 *
 * Reused only when its answer_url is exactly ours, or its name is exactly
 * APP_NAME (the name only this integration creates — then its URLs are
 * re-pointed at this backend, e.g. after the public host moved). Any other
 * application, whatever it is called, is left alone.
 */
async function ensureHubspotApp(auth) {
  const base = publicBase();
  if (!base || !base.startsWith("https://")) {
    log("  ⚠ cannot configure the Vobiz application: PUBLIC_BASE is not an https URL");
    return null;
  }
  const answerUrl = `${base}/answer`;
  const urls = { answer_url: answerUrl, answer_method: "POST", hangup_url: answerUrl, hangup_method: "POST" };

  const appList = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await vobiz("GET", `/Application/?limit=100&offset=${offset}`, null, auth);
    if (page.status < 200 || page.status >= 300) {
      log(`  ⚠ listing applications for ${auth.authId} returned ${page.status}`);
      return null;
    }
    const objs = (page.body && (page.body.objects || page.body.items)) || [];
    appList.push(...objs);
    if (objs.length < 100) break;
  }

  let app = appList.find((a) => a.answer_url === answerUrl);
  if (!app) {
    app = appList.find((a) => a.app_name === APP_NAME);
    if (app) {
      const id = idString(app.app_id || app.id);
      await vobiz("POST", `/Application/${encodeURIComponent(id)}/`, urls, auth);
      log(`re-pointed this integration's application ${id} at ${answerUrl}`);
    }
  }
  if (!app) {
    const created = await vobiz("POST", "/Application/", { app_name: APP_NAME, ...urls }, auth);
    if (created.status >= 400) {
      log(`  ⚠ creating the application for ${auth.authId} returned ${created.status}`);
      return null;
    }
    app = created.body || {};
    log(`created application ${idString(app.app_id || app.id)} for ${auth.authId} -> ${answerUrl}`);
  }
  const appId = idString(app.app_id || app.id);
  if (!APP_ID_RE.test(appId)) {
    log(`  ⚠ application id ${JSON.stringify(appId)} is not numeric; cannot bind endpoints to it`);
    return null;
  }
  const acct = accounts.get(auth.authId);
  if (acct) acct.appId = appId;
  return appId;
}

/** The app id an endpoint is bound to, as a string, from a GET /Endpoint/{id}/ response. */
function boundAppId(res) {
  const b = res && res.body;
  if (b && typeof b === "object") {
    const a = b.application;
    if (a && typeof a === "object") return idString(a.app_id || a.id);
    if (a != null && a !== "") return idString(a);
    if (b.app_id != null) return idString(b.app_id);
  }
  const m = /"app_id"\s*:\s*"?(\d+)/.exec((res && res.raw) || "");
  return m ? m[1] : "";
}

/**
 * Bind an endpoint to the application. First {"app_id": "<id>"} — the id as a
 * JSON string, which is what the working reference implementation sends —
 * then verify with GET; if it did not take, retry once with the documented
 * {"application": <integer>}. The 17-digit id is spliced into the JSON text
 * as a literal either way: it must never pass through Number() or
 * JSON.stringify of a number, which would round it.
 */
async function bindEndpoint(auth, epId, appId) {
  if (!epId || !APP_ID_RE.test(String(appId))) return false;
  const path_ = `/Endpoint/${encodeURIComponent(epId)}/`;
  await vobiz("POST", path_, `{"app_id":"${appId}"}`, auth);
  let got = await vobiz("GET", path_, null, auth);
  if (boundAppId(got) === String(appId)) {
    log(`bound endpoint ${epId} to application ${appId}`);
    return true;
  }
  await vobiz("POST", path_, `{"application":${appId}}`, auth);
  got = await vobiz("GET", path_, null, auth);
  const ok = boundAppId(got) === String(appId);
  log(ok ? `bound endpoint ${epId} to application ${appId} ("application" retry)`
    : `  ⚠ endpoint ${epId} is still not bound to application ${appId} (reads ${boundAppId(got) || "none"})`);
  return ok;
}

/**
 * Every number on the account: GET /numbers?page=N&per_page=100 until `total`
 * is reached. `first` is page 1, already fetched while checking credentials.
 * Ids stay strings (application_id is 17 digits).
 */
async function listAccountNumbers(auth, first) {
  const out = [];
  let seenCount = 0;
  let res = first;
  for (let page = 1; page <= 50; page++) {
    if (page > 1) res = await vobiz("GET", `/numbers?page=${page}&per_page=100`, null, auth);
    if (!res || res.status < 200 || res.status >= 300) break;
    const items = (res.body && (res.body.items || res.body.objects)) || [];
    seenCount += items.length;
    for (const n of items) {
      const e164 = toE164(n.e164 || n.number);
      if (!e164) continue;
      out.push({ e164, status: String(n.status || "").toLowerCase(), voiceEnabled: n.voice_enabled, applicationId: idString(n.application_id || n.app_id) || null });
    }
    const total = Number(res.body && res.body.total);
    if (!items.length) break;
    if (Number.isFinite(total) && total > 0 ? seenCount >= total : items.length < 100) break;
  }
  return out;
}

/** Attach a DID to the application. Only from the explicit "Enable inbound calls" action. */
async function attachNumber(auth, number, appId) {
  const digits = String(number).replace(/\D/g, "");
  const r = await vobiz("POST", `/numbers/%2B${digits}/application`, { application_id: String(appId) }, auth);
  log(`attach +${digits} -> application ${appId}: ${r.status}`);
  return r.status >= 200 && r.status < 300;
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
      // Outbound. The SIP From user is the agent's own endpoint; that is how
      // the account and the caller ID that agent picked are found (state the
      // panel set out of band, via /login, /login-sip or /select-number). The
      // panel also sends the choice on the INVITE as X-VH-Caller-ID, which
      // Vobiz passes to this webhook as a parameter; it wins when valid. An
      // unknown SIP user has no account here, so there is nothing to bill.
      const fromUser = sipUserPart(from);
      const s = liveSessions().find((x) => sipUserPart(x.sipUser) === fromUser);
      if (!s) return hangup(`outbound from sip:${fromUser}, which no signed-in agent owns`);
      let callerId = s.from;
      const headerCid = vhParam(params, "X-VH-Caller-ID");
      if (headerCid) {
        const cid = toE164(headerCid);
        // Account sign-in: must be one of that account's numbers. SIP direct:
        // strict E.164; Vobiz itself refuses a caller ID the account does not own.
        if (E164_RE.test(cid) && (s.kind === "sip" || (s.numbers || []).includes(cid))) callerId = cid;
        else log(`  ignoring X-VH-Caller-ID ${JSON.stringify(headerCid)} for ${fromUser}: not a valid number for this agent`);
      }
      if (!callerId || !E164_RE.test(callerId)) {
        return hangup(`agent ${s.agentId} (${s.authId || "SIP direct"}) has no caller ID`);
      }
      let dest = to.replace(/[^\d+]/g, "");
      if (dest && !dest.startsWith("+")) dest = `+${dest}`;
      if (!dest) return hangup("no destination number");
      remember({ callUuid, authId: s.authId || null, direction: "Outbound", from: callerId, to: dest, startedAt: Date.now() });
      log(`  -> browser is the A leg (${fromUser}, agent ${s.agentId}, ${s.authId || "SIP direct"}), dialling out to ${dest} as ${callerId}`);
      return send(res, 200,
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${record}\n  <Dial ${attrs(callerId)}>\n    <Number>${escXml(dest)}</Number>\n  </Dial>\n</Response>`);
    }

    // Inbound PSTN. Vobiz names the account on the webhook as ParentAuthID;
    // that is the primary key. Without it, the dialled DID is looked up among
    // signed-in accounts' numbers. Only that account's signed-in agents are
    // rung — never another account's. callerId is the dialled DID in E.164 (a
    // number the account owns); omit it and Vobiz derives it from the caller,
    // refuses the B leg, and the browser never rings.
    //
    // SIP direct agents have no account id: they are rung for the caller-ID
    // number they signed in with, and only when no account-mode agent of the
    // calling account is signed in.
    //
    // All matching agents ring at once: sibling <User> children, first to
    // answer wins.
    const dialedNumber = toE164(to);
    const politeHangup = (why) => {
      log(`  -> ${why}; playing a message and hanging up`);
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Speak>Sorry, no one is available to take your call right now. Please try again later.</Speak>\n  <Hangup/>\n</Response>`);
    };
    if (!dialedNumber) return politeHangup("inbound call with no dialled number");
    const parentAuthId = String(params.ParentAuthID || params.parentauthid || params.ParentAuthId || "").trim();
    const live = liveSessions();
    const owners = new Set();
    if (parentAuthId) {
      owners.add(parentAuthId);
    } else {
      for (const [authId, a] of accounts) if ((a.numbers || []).includes(dialedNumber)) owners.add(authId);
      for (const x of live) if (x.kind !== "sip" && (x.numbers || []).includes(dialedNumber)) owners.add(x.authId);
      if (owners.size > 1) log(`  ⚠ ${dialedNumber} appears on more than one signed-in account: ${[...owners].join(", ")}`);
    }
    let ringing = live.filter((x) => x.kind !== "sip" && owners.has(x.authId));
    if (!ringing.length) ringing = live.filter((x) => x.kind === "sip" && x.inboundNumber === dialedNumber);
    const targets = [...new Set(ringing.map((x) => x.sipUser).filter(Boolean).map((u) => (u.includes("@") ? u : `${u}@${REGISTRAR}`).replace(/^sips?:/, "")))];
    const who = parentAuthId ? `account ${parentAuthId}` : owners.size ? [...owners].join(", ") : "no signed-in account";
    if (!targets.length) return politeHangup(`inbound to ${dialedNumber} (${who}) but none of its agents is signed in`);
    const callerId = dialedNumber;
    remember({ callUuid, authId: ringing[0].authId || null, direction: "Inbound", from, to: callerId, startedAt: Date.now() });
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
    // Attributed to the account whose call this was; a recording for a call
    // this backend did not route is not attributed to anyone.
    if (recordingId && rec && rec.authId) {
      recordingMeta.set(recKey(rec.authId, recordingId), { authId: rec.authId, url: recordingUrl });
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
  // Every one of these except /login needs the session token
  // /login returned, as `Authorization: Bearer <token>`.

  // Account-API routes. A SIP direct session has no account credentials, so
  // it gets a clear 403 rather than a feature that silently does nothing.
  const requireSession = () => {
    const s = sessionFrom(req);
    if (!s) { send(res, 401, { error: "Sign in first" }); return null; }
    if (s.kind === "sip") { send(res, 403, { error: "Sign in with your Vobiz account to use this." }); return null; }
    const auth = accountAuth(s.authId);
    if (!auth) { send(res, 401, { error: "Sign in again" }); return null; }
    s.auth = auth;
    return s;
  };

  // The SIP identity the widget registers as: this agent's own endpoint.
  // `/agent/<id>` is accepted for older widgets but must match the session.
  if ((m = p.match(/^\/agent(?:\/([^/]+))?$/)) && method === "GET") {
    const s = requireSession();
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
      ? { loggedIn: true, kind: s.kind, agentId: s.agentId, numbers: s.numbers, numberDetails: s.numberDetails || [], from: s.from, authId: s.authId, sipUser: s.sipUser }
      : { loggedIn: false });
  }

  // Any Vobiz account can sign in. The pair is checked against Vobiz itself;
  // there is no "this backend belongs to account X" restriction and no
  // test/mock bypass. Then this agent's own endpoint is found or created in
  // THAT account and bound to this integration's application there.
  if (p === "/login" && method === "POST") {
    const body = await readBody(req);
    const agentId = String(body.agentId || "").trim();
    const authId = String(body.authId || "").trim();
    const authToken = String(body.authToken || "").trim();
    if (!agentId || !authId || !authToken) return send(res, 400, { error: "agentId, authId and authToken are required" });
    if (!AGENT_ID_RE.test(agentId)) return send(res, 400, { error: "agentId may contain only letters, digits, - and _" });
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(authId)) return send(res, 401, { error: "Invalid Auth ID or Auth Token" });

    const auth = { authId, authToken };
    const r = await vobiz("GET", "/numbers?page=1&per_page=100", null, auth);
    if (r.status === 0) {
      return send(res, 502, { error: "Could not reach Vobiz to check those credentials. Try again." });
    }
    if (r.status < 200 || r.status >= 300) {
      log(`login rejected by Vobiz for ${authId}: ${r.status}`);
      return send(res, 401, { error: "Vobiz did not accept that Auth ID and Auth Token. Copy both again from the Vobiz console (API credentials)." });
    }

    // The caller-ID list is the account's own numbers, all pages of them.
    const all = await listAccountNumbers(auth, r);
    const callerIds = all.filter((n) => n.status === "active" && n.voiceEnabled !== false);
    const numbers = callerIds.map((n) => n.e164);
    const numberDetails = callerIds.map((n) => ({ e164: n.e164, applicationId: n.applicationId }));
    const prev = accounts.get(authId);
    accounts.set(authId, { authToken, numbers: all.map((n) => n.e164), appId: prev && prev.authToken === authToken ? prev.appId : null });

    let sip;
    try {
      sip = await ensureAgentEndpoint(auth, agentId);
    } catch (err) {
      log(`⚠ could not provision a SIP endpoint for ${agentId} (${authId}):`, err.message);
      return send(res, 502, { error: `Could not set up a SIP endpoint for this agent: ${err.message}` });
    }

    // Outbound needs the endpoint bound to an application whose answer_url is
    // this backend. No number is attached here: that moves the DID off
    // whatever app it is on now, so it happens only on "Enable inbound calls".
    let appId = null, bound = false;
    try {
      appId = await ensureHubspotApp(auth);
      if (appId) bound = await bindEndpoint(auth, sip.epId, appId);
    } catch (err) {
      log(`⚠ application setup failed for ${authId}:`, err.message);
    }

    // Default caller ID: the agent's last choice if they are signing in again
    // and it is still on the list, else the first number.
    const prevSession = sessions.get(sessionByAgent.get(`${authId}:${agentId}`));
    const selectedFrom = (prevSession && numbers.includes(prevSession.from) && prevSession.from) || numbers[0] || "";
    const token = openSession({ kind: "account", agentId, authId, numbers, numberDetails, from: selectedFrom, ...sip });
    log(`login ok — ${agentId} (${authId}), ${numbers.length} number(s), sipUser: ${sip.sipUser}, app ${appId || "-"} bound=${bound}`);
    return send(res, 200, { token, agentId, numbers, numberDetails, selected: selectedFrom, authId, sipUser: sip.sipUser, routingReady: bound });
  }

  // SIP direct: the agent types an existing endpoint's SIP username and
  // password plus a caller-ID number, and the browser registers with those
  // itself. No env credentials and no account API: the password never reaches
  // this backend, which only records sipUser -> caller ID (also the number
  // inbound calls ring this agent on) so the webhooks can route. The customer
  // must already have bound that endpoint and DID to an application whose
  // answer URL is this backend; Vobiz enforces that the caller ID belongs to
  // the endpoint's account.
  if (p === "/login-sip" && method === "POST") {
    const body = await readBody(req);
    const agentId = String(body.agentId || "").trim();
    if (!agentId || !AGENT_ID_RE.test(agentId)) return send(res, 400, { error: "A valid agentId is required" });
    const username = sipUserPart(body.sipUser).trim();
    if (!/^[A-Za-z0-9]{1,64}$/.test(username)) return send(res, 400, { error: "Enter the endpoint's SIP username (letters and digits only)" });
    const from = toE164(String(body.callerId || "").replace(/[\s()-]/g, ""));
    if (!E164_RE.test(from)) return send(res, 400, { error: "Enter the caller ID in E.164 format, e.g. +<country code><number>" });
    const sipUser = `${username}@${REGISTRAR}`;
    // An endpoint this backend provisioned for an account sign-in stays that
    // agent's: SIP direct cannot claim it and change its caller ID.
    if (liveSessions().some((x) => x.kind !== "sip" && sipUserPart(x.sipUser) === username)) {
      return send(res, 409, { error: "That endpoint is in use by a Vobiz account sign-in" });
    }
    for (const [t, x] of sessions) if (x.kind === "sip" && sipUserPart(x.sipUser) === username) dropSession(t);
    const token = openSession({ kind: "sip", agentId, authId: null, sipUser, epId: null, numbers: [from], from, inboundNumber: from });
    log(`sip direct login ok — ${agentId} (${username}), callerId ${from}`);
    return send(res, 200, { ok: true, token, sipUser, from });
  }

  if (p === "/logout" && method === "POST") {
    const s = sessionFrom(req);
    if (s) {
      dropSession(s.token);
      log(`logout ok — session cleared for ${s.agentId}`);
    }
    return send(res, 200, { ok: true });
  }

  // Changes the caller ID for this agent's outbound calls only. It does not
  // touch number routing.
  if (p === "/select-number" && method === "POST") {
    const s = requireSession();
    if (!s) return;
    const { number } = await readBody(req);
    if (!s.numbers.includes(number)) return send(res, 400, { error: "That number is not on this account" });
    s.ref.from = number;
    log(`caller ID for ${s.agentId} (${s.authId}) -> ${number}`);
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
    const s = requireSession();
    if (!s) return;
    const r = await vobiz("GET", `/Call/${encodeURIComponent(m[1])}/?status=live`, null, s.auth);
    return send(res, 200, { active: r.status === 200 });
  }

  /**
   * "Enable inbound calls": the explicit action that attaches a DID on this
   * account to this integration's application (and re-checks the agent's
   * endpoint binding). Attaching moves the number off any other application,
   * which is why sign-in never does it. /provision-hubspot-dedicated is the
   * older widget's name for the same action; any tunnelUrl it sends is
   * ignored — the public host is deployment config (PUBLIC_BASE).
   */
  if ((p === "/setup-inbound" || p === "/provision-hubspot-dedicated") && method === "POST") {
    const s = requireSession();
    if (!s) return;
    const body = await readBody(req);
    const number = toE164(body.number) || s.from;
    if (!number || !s.numbers.includes(number)) {
      return send(res, 400, { error: "Choose a number that is on this Vobiz account" });
    }
    const base = publicBase();
    if (!base.startsWith("https://")) return send(res, 500, { error: "PUBLIC_BASE must be a public https URL Vobiz can reach" });
    const appId = await ensureHubspotApp(s.auth);
    if (!appId) return send(res, 502, { error: "Could not create or update the Vobiz application" });
    const bound = await bindEndpoint(s.auth, s.epId, appId);
    const detail = (s.numberDetails || []).find((n) => n.e164 === number);
    const previousApplicationId = detail && detail.applicationId && detail.applicationId !== appId ? detail.applicationId : null;
    const attached = await attachNumber(s.auth, number, appId);
    if (!attached) return send(res, 502, { error: `Vobiz did not attach ${number} to the application` });
    if (detail) detail.applicationId = appId;
    log(`inbound enabled — ${number} on ${s.authId} -> app ${appId}`);
    return send(res, 200, { ok: true, appId, appName: APP_NAME, answerUrl: `${base}/answer`, number, previousApplicationId, sipUser: s.sipUser, endpointBound: bound });
  }

  if ((p === "/recordings" || p.startsWith("/recordings/")) && method === "GET") {
    const s = requireSession();
    if (!s) return;
    const limit = Math.min(Number(url.searchParams.get("limit") || 15), 50);
    const r = await vobiz("GET", `/Recording/?limit=${limit}`, null, s.auth);
    const rawList = (r.body && (r.body.objects || r.body.items)) || [];
    const objects = rawList.filter((o) => o.recording_id).map((o) => {
      const recordingId = String(o.recording_id);
      recordingMeta.set(recKey(s.authId, recordingId), { authId: s.authId, url: o.recording_url || o.url || "" });
      return {
        recording_id: recordingId,
        add_time: o.add_time,
        rounded_recording_duration: o.rounded_recording_duration,
        call_uuid: o.call_uuid,
        playUrl: signRecordingUrl(s.authId, recordingId),
      };
    });
    return send(res, 200, { objects });
  }

  if ((p === "/cdrs" || p.startsWith("/cdrs/")) && method === "GET") {
    const s = requireSession();
    if (!s) return;
    const limit = Math.min(Number(url.searchParams.get("limit") || 15), 50);
    const r = await vobiz("GET", `/Call/?limit=${limit}`, null, s.auth);
    return send(res, 200, { objects: (r.body && r.body.objects) || [] });
  }

  /**
   * Playback. Signature-gated, not session-gated: an <audio> element cannot
   * send an Authorization header, so the proof travels in the URL — a
   * short-lived HMAC over (account, recording id, expiry), never account
   * credentials, and never a caller-supplied URL. The audio is fetched with
   * the credentials of the account named in the signed link, and only that.
   */
  if ((m = p.match(/^\/recording-audio\/([^/]+)$/)) && method === "GET") {
    const recordingId = decodeURIComponent(m[1]);
    const linkAuthId = url.searchParams.get("a") || "";
    if (!verifyRecordingSignature(linkAuthId, recordingId, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
      return send(res, 403, { error: "This playback link is invalid or has expired." });
    }
    const auth = accountAuth(linkAuthId);
    if (!auth) {
      // The token lives in memory only; after a restart it comes back when
      // someone on that account signs in again.
      return send(res, 401, { error: "Sign in to the calling panel again to play this recording." });
    }

    const meta = recordingMeta.get(recKey(linkAuthId, recordingId));
    let src = meta && meta.url;
    if (!src) {
      const got = await vobiz("GET", `/Recording/${encodeURIComponent(recordingId)}/`, null, auth);
      src = got.status >= 200 && got.status < 300 && got.body && (got.body.recording_url || got.body.url);
      if (src) recordingMeta.set(recKey(linkAuthId, recordingId), { authId: linkAuthId, url: src });
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
      sipMode: "per-agent",
      publicBase: publicBase() || null, sessions: liveSessions().length, recentCalls: recent.length,
    });
  }

  log(`404 ${method} ${p}`);
  return send(res, 404, { error: `No route for ${method} ${p}` });
});

server.listen(PORT, () => {
  console.log(`Vobiz HubSpot calling backend on http://localhost:${PORT}`);
  console.log("  accounts    any Vobiz account; agents sign in with their own Auth ID + Auth Token");
  console.log("  SIP         one endpoint per agent, created in the agent's account on first sign-in");
  console.log(`  public base ${publicBase() || "(NOT SET — Vobiz cannot reach the answer URL, calls will die)"}`);
});
