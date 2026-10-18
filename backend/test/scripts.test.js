/**
 * The setup scripts' config loading: no network, no real credentials.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseConfig, pickAccount, readHubspotCliConfig } = require("../../scripts/hubspot-cli-config");
const { loadConfig } = require("../../scripts/configure-calling");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-hs-scripts-"));

// The shape `hs account auth` writes to ~/.hscli/config.yml (CLI v8).
const V8_CONFIG = `defaultAccount: sandbox
portals:
  - name: prod-portal
    accountId: 1111111
    env: prod
    authType: personalaccesskey
    personalAccessKey: >-
      fake-pak-prod
  - name: sandbox
    accountId: 2222222
    env: prod
    authType: personalaccesskey
    auth:
      tokenInfo:
        accessToken: >-
          fake-access-token
        expiresAt: '2026-01-01T00:00:00.000Z'
    accountType: DEVELOPER_TEST
    personalAccessKey: >-
      fake-pak-sandbox
`;

// The older repo-root hubspot.config.yml.
const LEGACY_CONFIG = `defaultPortal: dev
portals:
- name: dev
  portalId: 3333333
  authType: personalaccesskey
  personalAccessKey: "fake-pak-legacy"
`;

test("CLI v8 config: the default account's key and id, not a nested token", () => {
  const acct = pickAccount(parseConfig(V8_CONFIG));
  assert.deepEqual(acct, { personalAccessKey: "fake-pak-sandbox", accountId: 2222222, name: "sandbox" });
});

test("defaultAccount may be an account id; with no default, the first account with a key", () => {
  assert.equal(pickAccount(parseConfig(V8_CONFIG.replace("defaultAccount: sandbox", "defaultAccount: 1111111"))).name, "prod-portal");
  assert.equal(pickAccount(parseConfig(V8_CONFIG.replace("defaultAccount: sandbox\n", ""))).name, "prod-portal");
});

test("legacy hubspot.config.yml: portalId, defaultPortal, quoted key, list at column 0", () => {
  assert.deepEqual(pickAccount(parseConfig(LEGACY_CONFIG)), { personalAccessKey: "fake-pak-legacy", accountId: 3333333, name: "dev" });
});

test("~/.hscli/config.yml is preferred; the repo-root file is the fallback", () => {
  const home = tmpDir();
  const repoRoot = tmpDir();
  fs.writeFileSync(path.join(repoRoot, "hubspot.config.yml"), LEGACY_CONFIG);
  assert.equal(readHubspotCliConfig({ home, repoRoot }).personalAccessKey, "fake-pak-legacy");

  fs.mkdirSync(path.join(home, ".hscli"));
  fs.writeFileSync(path.join(home, ".hscli", "config.yml"), V8_CONFIG);
  const cfg = readHubspotCliConfig({ home, repoRoot });
  assert.equal(cfg.personalAccessKey, "fake-pak-sandbox");
  assert.equal(cfg.file, path.join(home, ".hscli", "config.yml"));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test("no config anywhere: the error names both paths and how to create one", () => {
  const home = tmpDir();
  const repoRoot = tmpDir();
  assert.throws(() => readHubspotCliConfig({ home, repoRoot }), (err) =>
    err.message.includes(path.join(home, ".hscli", "config.yml")) &&
    err.message.includes(path.join(repoRoot, "hubspot.config.yml")) &&
    /hs account auth/.test(err.message));
  fs.writeFileSync(path.join(repoRoot, "hubspot.config.yml"), "portals:\n  - name: x\n");
  assert.throws(() => readHubspotCliConfig({ home, repoRoot }), /no account with a personalAccessKey/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test("hubspot.config.yml and .hscli/ are git-ignored", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "..", "..", ".gitignore"), "utf8").split("\n");
  for (const entry of ["hubspot.config.yml", ".hscli/", "backend/data/"]) assert.ok(ignore.includes(entry), entry);
});

test("configure-calling reads backend/.env, the shell wins, and WIDGET_URL defaults from PUBLIC_BASE", () => {
  const dir = tmpDir();
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, [
    "PUBLIC_BASE=https://hs-backend.example.com/",
    "HUBSPOT_APP_ID=1000",
    "HUBSPOT_DEVELOPER_API_KEY=file-key",
  ].join("\n"));

  const fromFile = loadConfig({}, envFile);
  assert.equal(fromFile.appId, "1000");
  assert.equal(fromFile.apiKey, "file-key");
  assert.equal(fromFile.widgetUrl, "https://hs-backend.example.com/widget/");

  const shell = loadConfig({ HUBSPOT_APP_ID: "2000", WIDGET_URL: "https://other.example.com/w/" }, envFile);
  assert.equal(shell.appId, "2000", "shell wins");
  assert.equal(shell.apiKey, "file-key");
  assert.equal(shell.widgetUrl, "https://other.example.com/w/");

  const none = loadConfig({ HUBSPOT_APP_ID: "3" }, path.join(dir, "missing.env"));
  assert.equal(none.appId, "3");
  assert.equal(none.widgetUrl, "", "no PUBLIC_BASE, no default");
  fs.rmSync(dir, { recursive: true, force: true });
});
