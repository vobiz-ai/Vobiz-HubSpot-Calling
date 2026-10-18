/**
 * Black-box tests: the real server.js runs as a child process against a fake
 * Vobiz API on localhost. Every assertion is on an HTTP response the server
 * actually produced, or on a request it actually sent to the fake.
 *
 * The fake hosts TWO accounts, because the backend must serve any Vobiz
 * account that signs in and keep them apart. No live Vobiz account is touched
 * and no call is placed. All ids, tokens and numbers here are fakes.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");

const A1 = "MA_TEST0001";
const T1 = "fake-token-account-one";
const A2 = "MA_TEST0002";
const T2 = "fake-token-account-two";
const DID = "+910000000001";
const DID2 = "+910000000002";
const DID_B = "+910000000003";
// 17 digits: above Number.MAX_SAFE_INTEGER. Number("43919358318796814") is
// 43919358318796816, so any numeric round trip shows up as a mismatch.
const APP_ID_1 = "43919358318796814";
const APP_ID_2 = "43919358318796999";
const PREV_APP = "20577609616603585";
const PUBLIC_BASE = "https://hs-backend.example.com";
const APP_NAME = "vobiz-hubspot-calling-integration";

// ─── fake Vobiz ──────────────────────────────────────────────────────────────
function fakeVobiz() {
  const accounts = {
    // Account one's endpoints accept {"app_id":"<string>"}; account two's only
    // the documented {"application": <int>}, so both bind paths are exercised.
    // PREV_APP is where DID2 is routed before "Enable inbound calls".
    [A1]: { token: T1, bindField: "app_id", numbers: [DID, DID2], appId: APP_ID_1,
      apps: [{ app_id: PREV_APP, app_name: "Old-IVR", answer_url: "https://customer.example.com/old-ivr" }],
      recordings: [{ recording_id: "rec-a1", recording_url: "https://media.not-allowed.example/a1.mp3", call_uuid: "c1" }] },
    [A2]: { token: T2, bindField: "application", numbers: [DID_B], appId: APP_ID_2,
      // Someone else's app that merely mentions HubSpot: must never be repointed.
      apps: [{ app_id: "11111111111111111", app_name: "My-HubSpot-IVR", answer_url: "https://customer.example.com/ivr" }],
      recordings: [{ recording_id: "rec-a2", recording_url: "https://media.not-allowed.example/a2.mp3", call_uuid: "c2" }] },
  };
  const state = { accounts, endpoints: new Map(), nextId: 9000, requests: [], passwords: new Map() };
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const u = req.url.split("?")[0];
      const am = u.match(/^\/api\/v1\/Account\/([^/]+)(\/.*)$/);
      const acctId = am && decodeURIComponent(am[1]);
      state.requests.push({ method: req.method, url: req.url, raw, body, account: acctId });
      const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(obj === undefined ? "" : typeof obj === "string" ? obj : JSON.stringify(obj)); };
      const acct = accounts[acctId];
      if (!acct || req.headers["x-auth-id"] !== acctId || req.headers["x-auth-token"] !== acct.token) {
        return reply(401, { error: { code: 401, message: "Invalid authentication credentials" } });
      }
      const rest = am[2];
      let m;
      if (req.method === "GET" && rest === "/numbers") {
        // Documented shape; pages of 2 so the backend must follow `total`.
        const q = new URL(req.url, "http://x").searchParams;
        const page = Number(q.get("page") || 1);
        const all = [
          ...acct.numbers.map((e164, i) => ({ e164, status: "active", voice_enabled: true, application_id: i === 1 ? PREV_APP : null })),
          ...(acctId === A1 ? [
            { e164: "+910000000050", status: "inactive", voice_enabled: true },
            { e164: "+910000000051", status: "active", voice_enabled: false },
          ] : []),
        ];
        return reply(200, { items: all.slice((page - 1) * 2, page * 2), page, per_page: 2, total: all.length });
      }
      if (req.method === "POST" && rest === "/Endpoint/") {
        const id = String(state.nextId++);
        // Vobiz rewrites the submitted username and the create response does
        // not carry the stored name.
        const ep = { endpoint_id: id, account: acctId, username: `${body.username}1187694299`, alias: body.alias, sip_registered: "false", application: null };
        state.endpoints.set(id, ep);
        state.passwords.set(id, body.password);
        return reply(201, { message: "created", endpoint_id: id });
      }
      if (req.method === "GET" && rest === "/Endpoint/") {
        const mine = [...state.endpoints.values()].filter((e) => e.account === acctId).map(({ account, password, ...pub }) => pub);
        return reply(200, { objects: mine });
      }
      if ((m = rest.match(/^\/Endpoint\/(\d+)\/$/))) {
        const ep = state.endpoints.get(m[1]);
        if (!ep || ep.account !== acctId) return reply(404, { error: "Endpoint not found" });
        if (req.method === "GET") {
          const { account, ...pub } = ep;
          // app_id rendered as a JSON STRING, as the docs show.
          return reply(200, { ...pub, application: ep.application ? { app_id: ep.application } : null });
        }
        if (body && body.password) state.passwords.set(m[1], body.password);
        // Read the integer from the raw text: JSON.parse would round it.
        const appM = new RegExp(`"${acct.bindField}"\\s*:\\s*"?(\\d+)`).exec(raw);
        if (appM) ep.application = appM[1];
        return reply(202);
      }
      if (req.method === "GET" && rest === "/Application/") return reply(200, { objects: acct.apps });
      if (req.method === "POST" && rest === "/Application/") {
        const app = { app_id: acct.appId, app_name: body.app_name, answer_url: body.answer_url };
        acct.apps.push(app);
        // app_id as a bare JSON number, the shape that breaks JSON.parse.
        return reply(201, `{"message":"created","app_id":${acct.appId},"app_name":"${body.app_name}"}`);
      }
      if (req.method === "POST" && rest.startsWith("/Application/")) return reply(202, { message: "changed" });
      if (req.method === "POST" && /^\/numbers\/.+\/application$/.test(rest)) return reply(202, { message: "changed" });
      if (req.method === "GET" && rest === "/Recording/") return reply(200, { objects: acct.recordings });
      if ((m = rest.match(/^\/Recording\/([^/]+)\/$/)) && req.method === "GET") {
        const r = acct.recordings.find((x) => x.recording_id === m[1]);
        return r ? reply(200, r) : reply(404, { error: "not found" });
      }
      return reply(404, { error: `fake has no ${req.method} ${rest}` });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, state, port: srv.address().port })));
}

// ─── server under test ───────────────────────────────────────────────────────
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d) => {
      out += d;
      if (out.includes("calling backend on")) resolve({ child, logs: () => out });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => reject(new Error(`server exited ${code}:\n${out}`)));
    setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 5000);
  });
}

const stop = (s) => new Promise((r) => { if (!s || s.child.exitCode !== null) return r(); s.child.removeAllListeners("exit"); s.child.on("exit", r); s.child.kill(); });

// Every response body and header the server sends is kept, so the last test
// can prove no Auth Token ever left the backend.
const seen = [];

function request(port, method, p, { body, headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, method, path: p,
      headers: {
        ...(data ? { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        seen.push(`${p}\n${JSON.stringify(res.headers)}\n${raw}`);
        let json = null;
        try { json = JSON.parse(raw); } catch { /* xml or text */ }
        resolve({ status: res.statusCode, headers: res.headers, text: raw, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let fake, srv, port, tmp, env;
let nextPort = 18400 + Math.floor(Math.random() * 500);

before(async () => {
  fake = await fakeVobiz();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-hs-test-"));
  port = nextPort++;
  // Deployment config only: no Vobiz account, number or SIP credential.
  env = {
    PORT: String(port),
    VOBIZ_API_URL: `http://127.0.0.1:${fake.port}`,
    PUBLIC_BASE,
    AGENT_ENDPOINT_STORE: path.join(tmp, "agent-endpoints.json"),
    SIGNING_SECRET: "test-secret",
  };
  srv = await startServer(env);
});

after(async () => {
  await stop(srv);
  fake.srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const login = (agentId, authId = A1, authToken = T1, p = port) =>
  request(p, "POST", "/login", { body: { agentId, authId, authToken } });
const reqsTo = (re, method = "POST") => fake.state.requests.filter((r) => r.method === method && re.test(r.url));
const answer = (form) => request(port, "POST", "/answer", { form });

// ─── auth ────────────────────────────────────────────────────────────────────
test("SIP credentials are never served without a session token", async () => {
  for (const p of ["/agent", "/agent/anyone", "/agent/test-agent"]) {
    const r = await request(port, "GET", p);
    assert.equal(r.status, 401, p);
    assert.ok(!/sipPassword/.test(r.text), p);
  }
  const forged = await request(port, "GET", "/agent", { headers: bearer("a".repeat(64)) });
  assert.equal(forged.status, 401);
});

test("a wrong token is refused with 401 and a clear message, with no test/mock bypass", async () => {
  for (const [authId, tok] of [[A1, "wrong"], [A2, T1], ["MA_TESTXXXX", T1], ["test", "x"], ["mock-account", "x"]]) {
    const r = await login("mallory", authId, tok);
    assert.equal(r.status, 401, `${authId} -> ${r.status}`);
    assert.equal(r.json.token, undefined);
    assert.match(r.json.error, /Auth ID and Auth Token/);
  }
  assert.equal(reqsTo(/\/Endpoint\/$/).length, 0, "nothing provisioned for a refused sign-in");
});

test("agentId is validated", async () => {
  const r = await login("../../etc");
  assert.equal(r.status, 400);
});

// ─── per-agent endpoints, any account ────────────────────────────────────────
let alice, bob, zed;

test("two agents on one account get two different endpoints, with the stored (rewritten) username", async () => {
  const a = await login("alice");
  const b = await login("bob");
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.match(a.json.token, /^[a-f0-9]{64}$/);
  assert.notEqual(a.json.token, b.json.token);

  const aa = await request(port, "GET", "/agent", { headers: bearer(a.json.token) });
  const bb = await request(port, "GET", "/agent", { headers: bearer(b.json.token) });
  assert.notEqual(aa.json.sipUser, bb.json.sipUser);
  assert.notEqual(aa.json.sipPassword, bb.json.sipPassword);
  assert.match(aa.json.sipUser, /^hsalice[a-f0-9]{6}1187694299@registrar\.vobiz\.ai$/);
  assert.match(bb.json.sipUser, /^hsbob[a-f0-9]{6}1187694299@registrar\.vobiz\.ai$/);
  const aliceEp = [...fake.state.endpoints.values()].find((e) => `${e.username}@registrar.vobiz.ai` === aa.json.sipUser);
  assert.equal(aliceEp.account, A1);
  assert.equal(fake.state.passwords.get(aliceEp.endpoint_id), aa.json.sipPassword);

  alice = { token: a.json.token, ...aa.json, epId: aliceEp.endpoint_id };
  bob = { token: b.json.token, ...bb.json };
});

test("a second, different Vobiz account signs in to the same backend and gets its own endpoint there", async () => {
  const z = await login("zed", A2, T2);
  assert.equal(z.status, 200, z.text);
  assert.deepEqual(z.json.numbers, [DID_B]);
  assert.equal(z.json.authId, A2);
  const zz = await request(port, "GET", "/agent", { headers: bearer(z.json.token) });
  const ep = [...fake.state.endpoints.values()].find((e) => `${e.username}@registrar.vobiz.ai` === zz.json.sipUser);
  assert.ok(ep, "endpoint exists");
  assert.equal(ep.account, A2, "created in account two, not account one");
  assert.notEqual(zz.json.sipUser, alice.sipUser);
  zed = { token: z.json.token, ...zz.json, epId: ep.endpoint_id };
});

test("the same agent id on two accounts maps to two endpoints", async () => {
  const x = await login("alice", A2, T2);
  assert.equal(x.status, 200, x.text);
  const xx = await request(port, "GET", "/agent", { headers: bearer(x.json.token) });
  assert.notEqual(xx.json.sipUser, alice.sipUser);
  // alice on account one is still signed in.
  const still = await request(port, "GET", "/agent", { headers: bearer(alice.token) });
  assert.equal(still.status, 200);
  await request(port, "POST", "/logout", { headers: bearer(x.json.token) });
});

test("sign-in binds the endpoint with the exact 17-digit app id ({app_id} first, {application} fallback) and does NOT attach any number", async () => {
  // Account one had no app of ours: one was created with this integration's name.
  const creates = reqsTo(new RegExp(`/Account/${A1}/Application/$`));
  assert.equal(creates.length, 1, "one application created for account one");
  assert.equal(creates[0].body.app_name, APP_NAME);
  assert.equal(creates[0].body.answer_url, `${PUBLIC_BASE}/answer`);
  assert.equal(creates[0].body.answer_method, "POST");

  const binds = reqsTo(new RegExp(`/Endpoint/${alice.epId}/$`)).filter((r) => /app/.test(r.raw));
  assert.equal(binds[0].raw, `{"app_id":"${APP_ID_1}"}`, "app id as an exact string");
  assert.equal(binds.length, 1, "verified by GET, no retry needed");
  assert.equal(fake.state.endpoints.get(alice.epId).application, APP_ID_1);

  // Account two ignores app_id: the documented integer form is the fallback.
  const zbinds = reqsTo(new RegExp(`/Endpoint/${zed.epId}/$`)).filter((r) => /app/.test(r.raw));
  assert.equal(zbinds[0].raw, `{"app_id":"${APP_ID_2}"}`);
  assert.equal(zbinds[1].raw, `{"application":${APP_ID_2}}`, "integer literal, not rounded");
  assert.equal(fake.state.endpoints.get(zed.epId).application, APP_ID_2);

  assert.equal(reqsTo(/\/numbers\/.+\/application$/).length, 0, "no DID moved on sign-in");
});

test("an application that only mentions HubSpot is never repointed", async () => {
  const touched = reqsTo(/\/Application\/11111111111111111\/$/);
  assert.equal(touched.length, 0);
  // A2 got its own application instead.
  assert.equal(reqsTo(new RegExp(`/Account/${A2}/Application/$`)).length, 1);
});

test("signing in again reuses this integration's application (matched by answer_url)", async () => {
  const before = reqsTo(/\/Application\/$/).length;
  const b2 = await login("bob");
  bob = { ...bob, token: b2.json.token };
  assert.equal(reqsTo(/\/Application\/$/).length, before, "no new application");
});

test("the caller-ID list is every page of the account's numbers, active and voice-enabled only", async () => {
  const a = await login("alice");
  assert.deepEqual(a.json.numbers, [DID, DID2], "inactive and non-voice numbers are not offered");
  assert.equal(a.json.selected, DID, "defaults to the first number");
  assert.deepEqual(a.json.numberDetails.map((n) => n.applicationId), [null, PREV_APP], "17-digit application_id kept exact");
  const pages = reqsTo(new RegExp(`/Account/${A1}/numbers\\?page=`), "GET").map((r) => new URL(r.url, "http://x").searchParams.get("page"));
  assert.ok(pages.includes("1") && pages.includes("2"), `paged: ${pages}`);
  const inactive = await request(port, "POST", "/select-number", { headers: bearer(a.json.token), body: { number: "+910000000050" } });
  assert.equal(inactive.status, 400, "an inactive number is refused as caller ID");
  // The agent's choice survives signing in again.
  await request(port, "POST", "/select-number", { headers: bearer(a.json.token), body: { number: DID2 } });
  const again = await login("alice");
  assert.equal(again.json.selected, DID2);
  await request(port, "POST", "/select-number", { headers: bearer(again.json.token), body: { number: DID } });
  alice = { ...alice, token: again.json.token };
});

test("an agent cannot read another agent's SIP identity", async () => {
  const r = await request(port, "GET", "/agent/bob", { headers: bearer(alice.token) });
  assert.equal(r.status, 403);
});

test("the agent -> endpoint map is persisted per account, without any password or token", async () => {
  const raw = fs.readFileSync(env.AGENT_ENDPOINT_STORE, "utf8");
  const store = JSON.parse(raw);
  assert.ok(store[`${A1}:alice`] && store[`${A1}:bob`] && store[`${A2}:zed`] && store[`${A2}:alice`]);
  assert.ok(!raw.includes(alice.sipPassword) && !/password/i.test(raw), "no SIP secret on disk");
  assert.ok(!raw.includes(T1) && !raw.includes(T2), "no auth token on disk");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(env.AGENT_ENDPOINT_STORE).mode & 0o077, 0, "store is 0600");
  }
});

// ─── answer XML ──────────────────────────────────────────────────────────────
test("inbound rings only the agents of the account that owns the dialled DID", async () => {
  const r = await answer({ From: "919800000000", To: "910000000001", CallUUID: "in-1" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /xml/);
  assert.match(r.text, /<Dial callerId="\+910000000001"/);
  assert.ok(r.text.includes(`<User>sip:${alice.sipUser}</User>`), r.text);
  assert.ok(r.text.includes(`<User>sip:${bob.sipUser}</User>`), r.text);
  assert.ok(!r.text.includes(zed.sipUser), "account two's agent is not rung");
  assert.match(r.text, /<Record [^>]*\/>\s*<Dial /, "Record is a sibling before Dial");
  assert.match(r.text, /action="https:\/\/hs-backend\.example\.com\/dial-status"[^>]*redirect="false"/);

  const r2 = await answer({ From: "919800000000", To: "+910000000003", CallUUID: "in-2" });
  assert.match(r2.text, /<Dial callerId="\+910000000003"/);
  assert.ok(r2.text.includes(`<User>sip:${zed.sipUser}</User>`), r2.text);
  assert.ok(!r2.text.includes(alice.sipUser) && !r2.text.includes(bob.sipUser), "account one's agents are not rung");
});

test("inbound to a number no signed-in account owns is a polite hangup, never another account's agents", async () => {
  const r = await answer({ From: "919800000000", To: "910000000099", CallUUID: "in-3" });
  assert.match(r.text, /<Speak>[^<]+<\/Speak>\s*<Hangup\/>/);
  assert.ok(!/<User>/.test(r.text), r.text);
});

test("inbound to an account with nobody signed in does not fall back to another account", async () => {
  const z2 = await login("zed", A2, T2);
  zed = { ...zed, token: z2.json.token };
  await request(port, "POST", "/logout", { headers: bearer(zed.token) });
  const r = await answer({ From: "919800000000", To: "910000000003", CallUUID: "in-4" });
  assert.ok(!/<User>/.test(r.text), r.text);
  assert.match(r.text, /<Hangup\/>/);
  const z3 = await login("zed", A2, T2);
  zed = { ...zed, token: z3.json.token };
});

test("outbound is routed by SIP user to that agent's account and caller ID", async () => {
  const sel = await request(port, "POST", "/select-number", { headers: bearer(bob.token), body: { number: DID2 } });
  assert.equal(sel.status, 200, sel.text);
  const r = await answer({ From: `sip:${bob.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-1" });
  assert.match(r.text, /<Dial callerId="\+910000000002"/);
  assert.match(r.text, /<Number>\+919800000001<\/Number>/);
  const ra = await answer({ From: `sip:${alice.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-2" });
  assert.match(ra.text, /<Dial callerId="\+910000000001"/);
  const rz = await answer({ From: `sip:${zed.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-3" });
  assert.match(rz.text, /<Dial callerId="\+910000000003"/);
});

test("outbound from an unknown SIP user is hung up, with no fallback caller ID", async () => {
  const r = await answer({ From: "sip:stranger123@registrar.vobiz.ai", To: "919800000001", RouteType: "sip", CallUUID: "out-x" });
  assert.match(r.text, /<Hangup\/>/);
  assert.ok(!/<Dial/.test(r.text));
});

test("inbound uses ParentAuthID first: the named account's agents ring, whatever the To", async () => {
  const r = await answer({ From: "919800000000", To: "07000000001", Direction: "inbound", ParentAuthID: A2, CallUUID: "in-p1" });
  assert.ok(r.text.includes(`<User>sip:${zed.sipUser}</User>`), r.text);
  assert.ok(!r.text.includes(alice.sipUser) && !r.text.includes(bob.sipUser));
  assert.match(r.text, /<Dial callerId="\+917000000001"/, "0XXXXXXXXXX -> +91XXXXXXXXXX");
  const unknown = await answer({ From: "919800000000", To: "910000000001", Direction: "inbound", ParentAuthID: "MA_TEST0009", CallUUID: "in-p2" });
  assert.ok(!/<User>/.test(unknown.text), "an unknown ParentAuthID never falls back to another account");
});

test("outbound honours X-VH-Caller-ID only when it is one of the agent's own numbers", async () => {
  const ok = await answer({ From: `sip:${alice.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-h1", "X-VH-Caller-ID": DID2 });
  assert.match(ok.text, /<Dial callerId="\+910000000002"/);
  const pref = await answer({ From: `sip:${alice.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-h2", "SIPHeader_X-VH-Caller-ID": DID2 });
  assert.match(pref.text, /<Dial callerId="\+910000000002"/);
  const foreign = await answer({ From: `sip:${alice.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-h3", "X-VH-Caller-ID": DID_B });
  assert.match(foreign.text, /<Dial callerId="\+910000000001"/, "another account's number is ignored");
  const junk = await answer({ From: `sip:${alice.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-h4", "X-VH-Caller-ID": "12\"><Hangup/>" });
  assert.match(junk.text, /<Dial callerId="\+910000000001"/);
});

// ─── SIP direct ──────────────────────────────────────────────────────────────
let dave;
test("SIP direct works with no env credentials: maps sipUser -> caller ID and never sees a password", async () => {
  const bad = await request(port, "POST", "/login-sip", { body: { agentId: "dave", sipUser: "daveep01", callerId: "12345" } });
  assert.equal(bad.status, 400);
  const taken = await request(port, "POST", "/login-sip", { body: { agentId: "dave", sipUser: alice.sipUser, callerId: "+910000000077" } });
  assert.equal(taken.status, 409, "an account-provisioned endpoint cannot be claimed");
  const ok = await request(port, "POST", "/login-sip", { body: { agentId: "dave", sipUser: "daveep01", sipPassword: "ignored", callerId: "+91 00000 00077" } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.from, "+910000000077");
  assert.ok(!/ignored/.test(JSON.stringify(ok.json)));
  dave = { token: ok.json.token, sipUser: ok.json.sipUser };

  const ses = await request(port, "GET", "/session", { headers: bearer(dave.token) });
  assert.equal(ses.json.kind, "sip");
  for (const [method, p] of [["GET", "/agent"], ["GET", "/recordings"], ["POST", "/setup-inbound"], ["POST", "/select-number"]]) {
    const r = await request(port, method, p, { headers: bearer(dave.token), body: {} });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.match(r.json.error, /Vobiz account/);
  }

  const out = await answer({ From: `sip:${dave.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-s1" });
  assert.match(out.text, /<Dial callerId="\+910000000077"/);
  const inb = await answer({ From: "919800000000", To: "910000000077", Direction: "inbound", CallUUID: "in-s1" });
  assert.ok(inb.text.includes(`<User>sip:${dave.sipUser}</User>`), inb.text);
  assert.ok(!inb.text.includes(alice.sipUser) && !inb.text.includes(zed.sipUser));
  // A DID owned by a signed-in account still rings only that account's agents.
  const acct = await answer({ From: "919800000000", To: "910000000001", CallUUID: "in-s2" });
  assert.ok(!acct.text.includes(dave.sipUser));
  await request(port, "POST", "/logout", { headers: bearer(dave.token) });
});

test("a Hangup notification gets an empty Response", async () => {
  const r = await answer({ Event: "Hangup", CallUUID: "in-1" });
  assert.match(r.text, /<Response><\/Response>/);
});

test("select-number refuses a number the account does not own, including another account's", async () => {
  for (const number of ["+910000000099", DID_B]) {
    const r = await request(port, "POST", "/select-number", { headers: bearer(alice.token), body: { number } });
    assert.equal(r.status, 400, number);
  }
});

// ─── Enable inbound calls ────────────────────────────────────────────────────
test("Enable inbound calls attaches the chosen DID to this account's application, and nothing else", async () => {
  const bad = await request(port, "POST", "/setup-inbound", { headers: bearer(alice.token), body: { number: DID_B } });
  assert.equal(bad.status, 400, "cannot attach another account's number");

  const r = await request(port, "POST", "/setup-inbound", { headers: bearer(alice.token), body: { number: DID2 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.appId, APP_ID_1, "17-digit app id survives as a string");
  const attaches = reqsTo(/\/numbers\/.+\/application$/);
  assert.equal(attaches.length, 1);
  assert.equal(attaches[0].account, A1);
  assert.equal(attaches.filter((r) => r.account === A1).length, 1);
  assert.match(attaches[0].url, /\/numbers\/%2B910000000002\/application$/);
  assert.match(attaches[0].raw, new RegExp(`"application_id":"${APP_ID_1}"`));
  assert.equal(r.json.previousApplicationId, PREV_APP, "says which app the number moved from");
  assert.equal(r.json.previousApplicationName, "Old-IVR", "and its name, from GET /Application/");
});

test("a number not on any other app reports no previous application", async () => {
  const r = await request(port, "POST", "/setup-inbound", { headers: bearer(alice.token), body: { number: DID } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.previousApplicationId, null);
  assert.equal(r.json.previousApplicationName, null);
});

test("the older provision route is the same action and cannot move PUBLIC_BASE", async () => {
  const r = await request(port, "POST", "/provision-hubspot-dedicated", {
    headers: bearer(alice.token), body: { number: DID, tunnelUrl: "https://evil.example" },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.answerUrl, `${PUBLIC_BASE}/answer`);
  const tunnelFile = path.join(__dirname, "..", "tunnel-url.txt");
  assert.ok(!fs.existsSync(tunnelFile) || !fs.readFileSync(tunnelFile, "utf8").includes("evil"));
});

// ─── recordings ──────────────────────────────────────────────────────────────
test("recording links are account-scoped: the account is signed into the link", async () => {
  const r1 = await request(port, "GET", "/recordings", { headers: bearer(alice.token) });
  const r2 = await request(port, "GET", "/recordings", { headers: bearer(zed.token) });
  assert.deepEqual(r1.json.objects.map((o) => o.recording_id), ["rec-a1"], "account one sees only its own");
  assert.deepEqual(r2.json.objects.map((o) => o.recording_id), ["rec-a2"]);
  const link1 = new URL(r1.json.objects[0].playUrl);
  assert.equal(link1.searchParams.get("a"), A1);

  // Valid link: passes the signature and account checks (then stops at the
  // media-host allowlist, because the fake's URL is deliberately off-list).
  const ok = await request(port, "GET", `${link1.pathname}${link1.search}`);
  assert.equal(ok.status, 502, ok.text);

  // Swap the account in an otherwise valid link: refused.
  const swapped = new URL(link1);
  swapped.searchParams.set("a", A2);
  const bad = await request(port, "GET", `${swapped.pathname}${swapped.search}`);
  assert.equal(bad.status, 403);

  // Account one's link shape pointed at account two's recording id: refused.
  const cross = await request(port, "GET", `/recording-audio/rec-a2${link1.search}`);
  assert.equal(cross.status, 403);
});

test("there is no caller-supplied-URL recording proxy, and playback needs a valid signature", async () => {
  const r = await request(port, "GET", "/recording-file?url=https://example.com/");
  assert.equal(r.status, 404);
  const a = await request(port, "GET", `/recording-audio/abc?a=${A1}&exp=9999999999&sig=deadbeef`);
  assert.equal(a.status, 403);
});

// ─── other routes need a session ─────────────────────────────────────────────
test("account routes refuse requests without a token", async () => {
  for (const [method, p] of [["GET", "/recordings/alice"], ["GET", "/cdrs/alice"], ["GET", "/call-status/x"],
    ["POST", "/select-number"], ["POST", "/setup-inbound"], ["POST", "/provision-hubspot-dedicated"]]) {
    const r = await request(port, method, p, { body: { agentId: "alice", tunnelUrl: "https://evil.example", number: DID } });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
});

test("logout invalidates the token", async () => {
  const t = await login("erin");
  await request(port, "POST", "/logout", { headers: bearer(t.json.token) });
  const r = await request(port, "GET", "/agent", { headers: bearer(t.json.token) });
  assert.equal(r.status, 401);
});

// ─── CORS, files, health ─────────────────────────────────────────────────────
test("CORS echoes only HubSpot, localhost and this backend's own origin", async () => {
  const acao = async (origin) => (await request(port, "GET", "/health", { headers: { Origin: origin } })).headers["access-control-allow-origin"];
  assert.equal(await acao("https://evil.example"), undefined);
  assert.equal(await acao("https://evil.trycloudflare.com"), undefined);
  assert.equal(await acao("https://attacker.ngrok-free.app"), undefined);
  assert.equal(await acao("https://app.hubspot.com"), "https://app.hubspot.com");
  assert.equal(await acao(PUBLIC_BASE), PUBLIC_BASE);
});

test("path traversal cannot read backend files", async () => {
  for (const p of ["/../backend/.env", "/widget/../backend/server.js", "/widget/..%2fbackend%2fserver.js", "/widget/../../backend/.env.example"]) {
    const r = await request(port, "GET", p);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
    assert.ok(!/SIGNING_SECRET|require\("node:http"\)/.test(r.text), p);
  }
});

test("/health does not expose any account id or SIP username", async () => {
  const r = await request(port, "GET", "/health");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(A1) && !r.text.includes(A2));
  assert.ok(!r.text.includes(alice.sipUser.split("@")[0]));
  assert.equal(r.json.sipMode, "per-agent");
});

// ─── restart ─────────────────────────────────────────────────────────────────
test("after a restart: old links say sign in again, then the agent reuses its endpoint with a new password", async () => {
  const r1 = await request(port, "GET", "/recordings", { headers: bearer(alice.token) });
  const link = new URL(r1.json.objects[0].playUrl);

  await stop(srv);
  srv = await startServer(env);

  const early = await request(port, "GET", `${link.pathname}${link.search}`);
  assert.equal(early.status, 401);
  assert.match(early.json.error, /[Ss]ign in/);

  const creates = reqsTo(/\/Endpoint\/$/).length;
  const a = await login("alice");
  assert.equal(a.status, 200, a.text);
  assert.equal(reqsTo(/\/Endpoint\/$/).length, creates, "no new endpoint");
  const aa = await request(port, "GET", "/agent", { headers: bearer(a.json.token) });
  assert.equal(aa.json.sipUser, alice.sipUser);
  assert.notEqual(aa.json.sipPassword, alice.sipPassword, "password rotated");
  assert.equal(fake.state.passwords.get(alice.epId), aa.json.sipPassword);
  alice = { ...alice, token: a.json.token, sipPassword: aa.json.sipPassword };

  const after = await request(port, "GET", `${link.pathname}${link.search}`);
  assert.equal(after.status, 502, "signature and account accepted again (stops at the media-host allowlist)");
});

test("an endpoint deleted on Vobiz is recreated, not silently reused", async () => {
  const c = await login("carol");
  const cc = await request(port, "GET", "/agent", { headers: bearer(c.json.token) });
  const ep = [...fake.state.endpoints.values()].find((e) => `${e.username}@registrar.vobiz.ai` === cc.json.sipUser);
  fake.state.endpoints.delete(ep.endpoint_id);
  const c2 = await login("carol");
  const cc2 = await request(port, "GET", "/agent", { headers: bearer(c2.json.token) });
  assert.notEqual(cc2.json.sipUser, cc.json.sipUser);
  await request(port, "POST", "/logout", { headers: bearer(c2.json.token) });
});

test("with the endpoint store wiped, the agent's endpoint is found again by its exact alias", async () => {
  fs.rmSync(env.AGENT_ENDPOINT_STORE);
  const creates = reqsTo(/\/Endpoint\/$/).length;
  const a = await login("alice");
  assert.equal(a.status, 200, a.text);
  assert.equal(reqsTo(/\/Endpoint\/$/).length, creates, "no new endpoint");
  const aa = await request(port, "GET", "/agent", { headers: bearer(a.json.token) });
  assert.equal(aa.json.sipUser, alice.sipUser);
});

test("HubSpot install asks for the oauth scope only, by default", async () => {
  const p2 = nextPort++;
  const s2 = await startServer({ ...env, PORT: String(p2), HUBSPOT_CLIENT_ID: "cid", HUBSPOT_CLIENT_SECRET: "csecret" });
  try {
    const r = await request(p2, "GET", "/hubspot/install");
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.location).searchParams.get("scope"), "oauth");
  } finally {
    await stop(s2);
  }
});

test("with DATA_DIR and no AGENT_ENDPOINT_STORE, state goes in DATA_DIR: dir 0700, file 0600", async () => {
  const p2 = nextPort++;
  const dataDir = path.join(tmp, "state", "data");
  const { AGENT_ENDPOINT_STORE, ...rest } = env;
  const s2 = await startServer({ ...rest, PORT: String(p2), DATA_DIR: dataDir });
  try {
    const r = await login("dana", A1, T1, p2);
    assert.equal(r.status, 200, r.text);
    const file = path.join(dataDir, "agent-endpoints.json");
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8"))[`${A1}:dana`]);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700, "DATA_DIR is 0700");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, "store is 0600");
    }
  } finally {
    await stop(s2);
  }
});

test("leftover VOBIZ_AUTH_ID / VOBIZ_FROM_NUMBER / VOBIZ_SIP_* in env are ignored: another account still signs in", async () => {
  const p2 = nextPort++;
  const s2 = await startServer({ ...env, PORT: String(p2), VOBIZ_AUTH_ID: A1, VOBIZ_AUTH_TOKEN: T1, VOBIZ_FROM_NUMBER: DID,
    VOBIZ_SIP_USER: "shareduser", VOBIZ_SIP_PASSWORD: "SharedPass123" });
  try {
    const r = await login("yuri", A2, T2, p2);
    assert.equal(r.status, 200, r.text);
    const ag = await request(p2, "GET", "/agent", { headers: bearer(r.json.token) });
    assert.notEqual(ag.json.sipUser, "shareduser@registrar.vobiz.ai");
    assert.match(ag.json.sipUser, /^hsyuri/);
    assert.ok(!s2.logs().includes(T1), "env token not logged");
  } finally {
    await stop(s2);
  }
});

// ─── must stay last ──────────────────────────────────────────────────────────
test("no Auth Token ever appears in any HTTP response, or in the server log", async () => {
  assert.ok(seen.length > 50, `checked ${seen.length} responses`);
  for (const r of seen) {
    assert.ok(!r.includes(T1), `account one's token leaked in: ${r.slice(0, 120)}`);
    assert.ok(!r.includes(T2), `account two's token leaked in: ${r.slice(0, 120)}`);
  }
  assert.ok(!srv.logs().includes(T1) && !srv.logs().includes(T2), "token in server log");
});
