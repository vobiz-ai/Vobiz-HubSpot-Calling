/**
 * Black-box tests: the real server.js runs as a child process against a fake
 * Vobiz API on localhost. Every assertion is on an HTTP response the server
 * actually produced, or on a request it actually sent to the fake.
 *
 * No live Vobiz account is touched and no call is placed.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const AUTH_ID = "MA_FAKE0001";
const AUTH_TOKEN = "good-token";
const DID = "+911111111111";
const DID2 = "+912222222222";

// ─── fake Vobiz ──────────────────────────────────────────────────────────────
function fakeVobiz() {
  const state = { endpoints: new Map(), nextId: 9000, requests: [], passwords: new Map() };
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: req.method, url: req.url, body });
      const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
      if (req.headers["x-auth-id"] !== AUTH_ID || req.headers["x-auth-token"] !== AUTH_TOKEN) {
        return reply(401, { error: { code: 401, message: "Invalid authentication credentials" } });
      }
      const base = `/api/v1/Account/${AUTH_ID}`;
      const u = req.url.split("?")[0];
      if (req.method === "GET" && u === `${base}/numbers`) return reply(200, { objects: [{ e164: DID }, { e164: DID2 }] });
      if (req.method === "GET" && u === `${base}/Endpoint/`) {
        return reply(200, { objects: [...state.endpoints.values()] });
      }
      if (req.method === "POST" && u === `${base}/Endpoint/`) {
        const id = String(state.nextId++);
        // Vobiz rewrites the submitted username and the create response does
        // not carry the stored name.
        const ep = { endpoint_id: id, username: `${body.username}1187694299`, alias: body.alias, sip_registered: "false" };
        state.endpoints.set(id, ep);
        state.passwords.set(id, body.password);
        return reply(201, { message: "created", endpoint_id: id });
      }
      let m;
      if ((m = u.match(new RegExp(`^${base}/Endpoint/(\\d+)/$`)))) {
        const ep = state.endpoints.get(m[1]);
        if (!ep) return reply(404, { error: "Endpoint not found" });
        if (req.method === "GET") return reply(200, ep);
        if (body && body.password) state.passwords.set(m[1], body.password);
        if (body && body.app_id) ep.app_id = body.app_id;
        return reply(202);
      }
      if (req.method === "GET" && u === `${base}/Application/`) return reply(200, { objects: [] });
      if (req.method === "POST" && u === `${base}/Application/`) return reply(201, { app_id: "77", app_name: body.app_name });
      if (req.method === "POST" && u.startsWith(`${base}/Application/`)) return reply(202, { message: "changed" });
      if (req.method === "POST" && /\/numbers\/.+\/application$/.test(u)) return reply(202, { message: "changed" });
      if (req.method === "GET" && u === `${base}/Recording/`) return reply(200, { objects: [] });
      return reply(404, { error: `fake has no ${req.method} ${u}` });
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
  env = {
    PORT: String(port),
    VOBIZ_AUTH_ID: AUTH_ID,
    VOBIZ_AUTH_TOKEN: AUTH_TOKEN,
    VOBIZ_FROM_NUMBER: DID,
    VOBIZ_API_URL: `http://127.0.0.1:${fake.port}`,
    PUBLIC_BASE: "https://hs-backend.example.com",
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

const login = (agentId, authId = AUTH_ID, authToken = AUTH_TOKEN) =>
  request(port, "POST", "/login", { body: { agentId, authId, authToken } });

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

test("bad credentials are rejected, with no test/mock/MA_ bypass", async () => {
  for (const authId of [AUTH_ID, "MA_TESTXXXX", "test", "mock-account"]) {
    const r = await login("mallory", authId, "wrong");
    assert.ok(r.status === 401 || r.status === 403, `${authId} -> ${r.status}`);
    assert.equal(r.json.token, undefined);
  }
});

test("a different account is refused when the backend is bound to one", async () => {
  const r = await login("mallory", "MA_OTHER001", AUTH_TOKEN);
  assert.equal(r.status, 403);
});

test("agentId is validated", async () => {
  const r = await login("../../etc", AUTH_ID, AUTH_TOKEN);
  assert.equal(r.status, 400);
});

// ─── per-agent endpoints ─────────────────────────────────────────────────────
let alice, bob;

test("two agents get two different endpoints, with the stored (rewritten) username", async () => {
  const before = fake.state.endpoints.size;
  const a = await login("alice");
  const b = await login("bob");
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.match(a.json.token, /^[a-f0-9]{64}$/);
  assert.notEqual(a.json.token, b.json.token);
  assert.equal(fake.state.endpoints.size, before + 2, "one endpoint created per agent");

  const aa = await request(port, "GET", "/agent", { headers: bearer(a.json.token) });
  const bb = await request(port, "GET", "/agent", { headers: bearer(b.json.token) });
  assert.equal(aa.status, 200);
  assert.equal(bb.status, 200);
  assert.notEqual(aa.json.sipUser, bb.json.sipUser);
  assert.notEqual(aa.json.sipPassword, bb.json.sipPassword);
  // The registered name is the one Vobiz stored, read back with GET.
  assert.match(aa.json.sipUser, /^hsalice[a-f0-9]{6}1187694299@registrar\.vobiz\.ai$/);
  assert.match(bb.json.sipUser, /^hsbob[a-f0-9]{6}1187694299@registrar\.vobiz\.ai$/);
  // The password handed to the browser is the one set on THAT endpoint.
  const aliceEp = [...fake.state.endpoints.values()].find((e) => `${e.username}@registrar.vobiz.ai` === aa.json.sipUser);
  assert.equal(fake.state.passwords.get(aliceEp.endpoint_id), aa.json.sipPassword);
  assert.notEqual(aa.json.sipPassword, "vobiz123");

  alice = { token: a.json.token, ...aa.json, epId: aliceEp.endpoint_id };
  bob = { token: b.json.token, ...bb.json };
});

test("an agent cannot read another agent's SIP identity", async () => {
  const r = await request(port, "GET", "/agent/bob", { headers: bearer(alice.token) });
  assert.equal(r.status, 403);
});

test("the agent -> endpoint map is persisted without any password", async () => {
  const store = JSON.parse(fs.readFileSync(env.AGENT_ENDPOINT_STORE, "utf8"));
  assert.ok(store[`${AUTH_ID}:alice`], "alice is mapped");
  assert.ok(store[`${AUTH_ID}:bob`], "bob is mapped");
  const raw = fs.readFileSync(env.AGENT_ENDPOINT_STORE, "utf8");
  assert.ok(!raw.includes(alice.sipPassword) && !/password/i.test(raw), "no secret on disk");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(env.AGENT_ENDPOINT_STORE).mode & 0o077, 0, "store is 0600");
  }
});

test("after a restart the same agent reuses its endpoint and gets a new password", async () => {
  await stop(srv);
  srv = await startServer(env);
  const creates = fake.state.requests.filter((r) => r.method === "POST" && /\/Endpoint\/$/.test(r.url)).length;
  const a = await login("alice");
  assert.equal(a.status, 200, a.text);
  const again = fake.state.requests.filter((r) => r.method === "POST" && /\/Endpoint\/$/.test(r.url)).length;
  assert.equal(again, creates, "no new endpoint");
  const aa = await request(port, "GET", "/agent", { headers: bearer(a.json.token) });
  assert.equal(aa.json.sipUser, alice.sipUser);
  assert.notEqual(aa.json.sipPassword, alice.sipPassword, "password rotated");
  assert.equal(fake.state.passwords.get(alice.epId), aa.json.sipPassword);
  alice = { ...alice, token: a.json.token, sipPassword: aa.json.sipPassword };
  const b = await login("bob");
  bob = { ...bob, token: b.json.token };
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

// ─── answer XML ──────────────────────────────────────────────────────────────
test("inbound rings every signed-in agent, callerId is the dialled DID in E.164", async () => {
  const r = await request(port, "POST", "/answer", { form: { From: "919800000000", To: "911111111111", CallUUID: "in-1" } });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /xml/);
  assert.match(r.text, /<Dial callerId="\+911111111111"/);
  assert.ok(r.text.includes(`<User>sip:${alice.sipUser}</User>`), r.text);
  assert.ok(r.text.includes(`<User>sip:${bob.sipUser}</User>`), r.text);
  assert.match(r.text, /<Record [^>]*\/>\s*<Dial /, "Record is a sibling before Dial");
  assert.match(r.text, /action="https:\/\/hs-backend\.example\.com\/dial-status"[^>]*redirect="false"/);
});

test("outbound uses the calling agent's own caller ID", async () => {
  const sel = await request(port, "POST", "/select-number", { headers: bearer(bob.token), body: { number: DID2 } });
  assert.equal(sel.status, 200, sel.text);
  const r = await request(port, "POST", "/answer", {
    form: { From: `sip:${bob.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-1" },
  });
  assert.match(r.text, /<Dial callerId="\+912222222222"/);
  assert.match(r.text, /<Number>\+919800000001<\/Number>/);
  const ra = await request(port, "POST", "/answer", {
    form: { From: `sip:${alice.sipUser}`, To: "919800000001", RouteType: "sip", CallUUID: "out-2" },
  });
  assert.match(ra.text, /<Dial callerId="\+911111111111"/);
});

test("a Hangup notification gets an empty Response", async () => {
  const r = await request(port, "POST", "/answer", { form: { Event: "Hangup", CallUUID: "in-1" } });
  assert.match(r.text, /<Response><\/Response>/);
});

test("select-number refuses a number the account does not own", async () => {
  const r = await request(port, "POST", "/select-number", { headers: bearer(alice.token), body: { number: "+919999999999" } });
  assert.equal(r.status, 400);
});

// ─── SIP direct ──────────────────────────────────────────────────────────────
test("SIP direct only accepts an endpoint and caller ID the account owns, and never yields a password", async () => {
  const bad = await request(port, "POST", "/login-sip", { body: { agentId: "dave", sipUser: "notmine", callerId: DID } });
  assert.equal(bad.status, 403);
  const badNum = await request(port, "POST", "/login-sip", { body: { agentId: "dave", sipUser: alice.sipUser, callerId: "+919999999999" } });
  assert.equal(badNum.status, 403);
  const ok = await request(port, "POST", "/login-sip", { body: { agentId: "dave", sipUser: alice.sipUser, sipPassword: "ignored", callerId: DID } });
  assert.equal(ok.status, 200, ok.text);
  const ag = await request(port, "GET", "/agent", { headers: bearer(ok.json.token) });
  assert.equal(ag.status, 403);
  assert.ok(!/sipPassword/.test(ag.text));
  const rec = await request(port, "GET", "/recordings", { headers: bearer(ok.json.token) });
  assert.equal(rec.status, 403, "SIP direct cannot read account recordings");
  await request(port, "POST", "/logout", { headers: bearer(ok.json.token) });
});

// ─── other routes need a session ─────────────────────────────────────────────
test("account routes refuse requests without a token", async () => {
  for (const [method, p] of [["GET", "/recordings/alice"], ["GET", "/cdrs/alice"], ["GET", "/call-status/x"],
    ["POST", "/select-number"], ["POST", "/setup-inbound"], ["POST", "/provision-hubspot-dedicated"]]) {
    const r = await request(port, method, p, { body: { agentId: "alice", tunnelUrl: "https://evil.example", number: DID } });
    assert.equal(r.status, 401, `${method} ${p}`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "tunnel-url.txt")) ||
    !fs.readFileSync(path.join(__dirname, "..", "tunnel-url.txt"), "utf8").includes("evil"), "tunnel URL not hijacked");
});

test("logout invalidates the token", async () => {
  const t = await login("erin");
  await request(port, "POST", "/logout", { headers: bearer(t.json.token) });
  const r = await request(port, "GET", "/agent", { headers: bearer(t.json.token) });
  assert.equal(r.status, 401);
});

// ─── CORS, files, proxy ──────────────────────────────────────────────────────
test("CORS echoes only HubSpot, localhost and this backend's own origin", async () => {
  const acao = async (origin) => (await request(port, "GET", "/health", { headers: { Origin: origin } })).headers["access-control-allow-origin"];
  assert.equal(await acao("https://evil.example"), undefined);
  assert.equal(await acao("https://evil.trycloudflare.com"), undefined);
  assert.equal(await acao("https://attacker.ngrok-free.app"), undefined);
  assert.equal(await acao("https://app.hubspot.com"), "https://app.hubspot.com");
  assert.equal(await acao("https://hs-backend.example.com"), "https://hs-backend.example.com");
});

test("path traversal cannot read backend files", async () => {
  for (const p of ["/../backend/.env", "/widget/../backend/server.js", "/widget/..%2fbackend%2fserver.js", "/widget/../../backend/.env.example"]) {
    const r = await request(port, "GET", p);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
    assert.ok(!/VOBIZ_AUTH_TOKEN|require\("node:http"\)/.test(r.text), p);
  }
});

test("there is no caller-supplied-URL recording proxy, and playback needs a valid signature", async () => {
  const r = await request(port, "GET", "/recording-file?url=https://example.com/");
  assert.equal(r.status, 404);
  const a = await request(port, "GET", "/recording-audio/abc?exp=9999999999&sig=deadbeef");
  assert.equal(a.status, 403);
});

test("/health does not expose the account id or SIP username", async () => {
  const r = await request(port, "GET", "/health");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(AUTH_ID));
  assert.ok(!r.text.includes(alice.sipUser.split("@")[0]));
  assert.equal(r.json.sipMode, "per-agent");
});

// ─── single-endpoint mode ────────────────────────────────────────────────────
test("with VOBIZ_SIP_USER set, every agent registers as that endpoint (single-agent mode)", async () => {
  const p2 = nextPort++;
  const s2 = await startServer({ ...env, PORT: String(p2), VOBIZ_SIP_USER: "shareduser", VOBIZ_SIP_PASSWORD: "SharedPass123",
    AGENT_ENDPOINT_STORE: path.join(tmp, "unused.json") });
  try {
    const before = fake.state.endpoints.size;
    const r = await request(p2, "POST", "/login", { body: { agentId: "zed", authId: AUTH_ID, authToken: AUTH_TOKEN } });
    assert.equal(r.status, 200);
    const ag = await request(p2, "GET", "/agent", { headers: bearer(r.json.token) });
    assert.equal(ag.json.sipUser, "shareduser@registrar.vobiz.ai");
    assert.equal(fake.state.endpoints.size, before, "no endpoint created");
  } finally {
    await stop(s2);
  }
});
