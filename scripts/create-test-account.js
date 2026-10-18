#!/usr/bin/env node
/**
 * Create a HubSpot developer test account.
 *
 * Why this exists: installing a calling app into a real CRM portal requires the
 * installing user to hold CRM permissions (contacts-writer, team contact
 * visibility, and some internal ones like mam-reports-virtual-user). If you are
 * the only user on that portal, HubSpot's "request approval" flow has nobody to
 * ask and fails with "There was a problem fetching approvers" — a dead end.
 *
 * A developer test account has full permissions and is the intended place to
 * test an app before it is listed.
 *
 * Usage:
 *   node scripts/create-test-account.js "My Test Account"
 *
 * Requires a HubSpot CLI config with a personal access key carrying
 * developer.test_accounts.write (the default set includes it): CLI v8 keeps it
 * in ~/.hscli/config.yml (`npx hs account auth`); older CLIs wrote
 * hubspot.config.yml in the repo root. Both are read, in that order.
 */
const { readHubspotCliConfig } = require("./hubspot-cli-config");

const NAME = process.argv[2] || "Calling Test Account";

let pak, portalId;
try {
  const cfg = readHubspotCliConfig();
  pak = cfg.personalAccessKey;
  portalId = cfg.accountId;
  console.log(`Using account ${cfg.name || portalId} from ${cfg.file}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

(async () => {
  // Exchange the personal access key for a short-lived access token, the same
  // way the CLI does.
  const auth = await fetch("https://api.hubapi.com/localdevauth/v1/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encodedOAuthRefreshToken: pak, portalId }),
  });
  if (!auth.ok) { console.error(`Could not exchange the access key: ${auth.status}`); process.exit(1); }
  const { oauthAccessToken } = await auth.json();

  const res = await fetch("https://api.hubapi.com/integrators/test-portals/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${oauthAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ parentPortalId: portalId, accountName: NAME, accountType: "DEVELOPER_TEST" }),
  });
  const body = await res.text();
  if (!res.ok) { console.error(`✗ HubSpot returned ${res.status}`); console.error(body.slice(0, 400)); process.exit(1); }

  const acct = JSON.parse(body);
  console.log("✓ Test account created");
  console.log(`  id     ${acct.id}`);
  console.log(`  name   ${acct.accountName}`);
  console.log(`  trial  ends ${acct.trialEndsAt}`);
  console.log("\n  Install the app into it by opening /hubspot/install and selecting this account.");
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
