/**
 * HubSpot OAuth 2.0.
 *
 * The install flow redirects here after the user approves the app. Without this
 * route the redirect 404s — the app still installs, because HubSpot records
 * that before redirecting, but the backend never gets tokens and so cannot
 * write engagements server-side.
 *
 * Access tokens are short-lived (~30 minutes). Refresh tokens do not expire but
 * are revoked if the app is uninstalled. Every API call goes through
 * `hubspotFetch`, which refreshes on demand and retries once, so a token
 * expiring mid-request is invisible to callers rather than a random 401.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const TOKEN_STORE = path.join(__dirname, "hubspot-tokens.json");

const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

let tokens = null;

function loadTokens() {
  if (tokens) return tokens;
  try { tokens = JSON.parse(fs.readFileSync(TOKEN_STORE, "utf8")); } catch { tokens = null; }
  return tokens;
}

function saveTokens(next) {
  tokens = next;
  try {
    // 0600: this holds a refresh token, a long-lived credential for the
    // customer's CRM.
    fs.writeFileSync(TOKEN_STORE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[hubspot-oauth] could not persist tokens:", err.message);
  }
}

const isConfigured = (env) =>
  Boolean(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET && env.HUBSPOT_REDIRECT_URI);
const isConnected = () => Boolean(loadTokens() && loadTokens().refresh_token);

function buildAuthorizeUrl(env, scopes) {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());
  for (const [k, t] of pendingStates) if (Date.now() - t > STATE_TTL_MS) pendingStates.delete(k);
  const params = new URLSearchParams({
    client_id: env.HUBSPOT_CLIENT_ID,
    redirect_uri: env.HUBSPOT_REDIRECT_URI,
    scope: scopes,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const issued = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() - issued <= STATE_TTL_MS;
}

async function postToken(env, extra) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: env.HUBSPOT_REDIRECT_URI,
      ...extra,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error_description || json.error || `token endpoint returned ${res.status}`);
  return json;
}

function store(json) {
  saveTokens({
    access_token: json.access_token,
    refresh_token: json.refresh_token || (tokens && tokens.refresh_token),
    // 60s of headroom so a call started just before expiry does not race it.
    expires_at: Date.now() + (Number(json.expires_in || 1800) - 60) * 1000,
  });
}

async function exchangeCode(env, code) {
  store(await postToken(env, { grant_type: "authorization_code", code }));
  return tokens;
}

async function refresh(env) {
  const cur = loadTokens();
  if (!cur || !cur.refresh_token) throw new Error("Not connected to HubSpot");
  store(await postToken(env, { grant_type: "refresh_token", refresh_token: cur.refresh_token }));
  console.log("[hubspot-oauth] access token refreshed");
  return tokens;
}

async function accessToken(env) {
  const cur = loadTokens();
  if (!cur) throw new Error("Not connected to HubSpot");
  if (!cur.expires_at || Date.now() >= cur.expires_at) return (await refresh(env)).access_token;
  return cur.access_token;
}

async function hubspotFetch(env, apiPath, options = {}, retried = false) {
  const token = await accessToken(env);
  const res = await fetch(`https://api.hubapi.com${apiPath.startsWith("/") ? "" : "/"}${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  // One retry on 401: the token can expire between our check and the request.
  if (res.status === 401 && !retried) { await refresh(env); return hubspotFetch(env, apiPath, options, true); }
  return res;
}

function status() {
  const t = loadTokens();
  return t
    ? { connected: true, accessTokenExpiresAt: t.expires_at ? new Date(t.expires_at).toISOString() : null }
    : { connected: false };
}

function disconnect() {
  tokens = null;
  try { fs.unlinkSync(TOKEN_STORE); } catch { /* already gone */ }
}

module.exports = { isConfigured, isConnected, buildAuthorizeUrl, consumeState, exchangeCode, refresh, accessToken, hubspotFetch, status, disconnect };
