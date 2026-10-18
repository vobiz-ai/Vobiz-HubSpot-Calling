const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveDataDir, readJson, writeJson } = require("../state-files");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-hs-state-"));

test("DATA_DIR defaults to backend/data and resolves relative paths from backend/", () => {
  assert.equal(resolveDataDir({}, "/srv/app/backend"), "/srv/app/backend/data");
  assert.equal(resolveDataDir({ DATA_DIR: "./state" }, "/srv/app/backend"), "/srv/app/backend/state");
  assert.equal(resolveDataDir({ DATA_DIR: "/var/lib/vobiz" }, "/srv/app/backend"), "/var/lib/vobiz");
});

test("an old file is read when the new one does not exist yet, and the next write goes to the new path", () => {
  const dir = tmpDir();
  const legacy = path.join(dir, "agent-endpoints.json");
  const next = path.join(dir, "data", "agent-endpoints.json");
  fs.writeFileSync(legacy, JSON.stringify({ "MA_TEST0001:alice": { endpointId: "1" } }));
  assert.deepEqual(readJson(next, legacy), { "MA_TEST0001:alice": { endpointId: "1" } });

  writeJson(next, { "MA_TEST0001:alice": { endpointId: "2" } });
  assert.deepEqual(readJson(next, legacy), { "MA_TEST0001:alice": { endpointId: "2" } }, "new file wins once it exists");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(next)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(next).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(next)), ["agent-endpoints.json"], "no temp file left behind");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("missing or corrupt state reads as null", () => {
  const dir = tmpDir();
  assert.equal(readJson(path.join(dir, "nope.json"), path.join(dir, "also-nope.json")), null);
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  assert.equal(readJson(path.join(dir, "bad.json")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an existing file rewritten keeps mode 0600 even if it had been loosened", { skip: process.platform === "win32" }, () => {
  const dir = tmpDir();
  const file = path.join(dir, "data", "hubspot-tokens.json");
  writeJson(file, { a: 1 });
  fs.chmodSync(file, 0o644);
  writeJson(file, { a: 2 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
