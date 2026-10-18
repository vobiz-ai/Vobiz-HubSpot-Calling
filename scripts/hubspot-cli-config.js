/**
 * Read the HubSpot CLI's account config: the personal access key and account
 * id of the default account.
 *
 * Where the CLI keeps it:
 *   ~/.hscli/config.yml       CLI v7.x/v8 global config, written by `hs account auth`
 *   <repo>/hubspot.config.yml  older per-directory config, written by `hs init`
 *
 * Both hold a personal access key, a long-lived credential. Neither belongs in
 * git; both paths are in .gitignore.
 *
 * Only the handful of keys needed here are parsed — enough YAML for what the
 * CLI writes, including the folded `>-` scalars it uses for keys.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
const indentOf = (line) => line.match(/^ */)[0].length;

// Parse the account list (`accounts:` or `portals:`) and the default account
// (`defaultAccount:` or `defaultPortal:`).
function parseConfig(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let defaultAccount = null;
  const accounts = [];
  let inList = false;
  let current = null;
  let itemIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = indentOf(line);

    // A list may also sit at column 0 under its key ("portals:\n- name: x").
    if (indent === 0 && !(inList && line.startsWith("- "))) {
      inList = /^(accounts|portals):\s*$/.test(line);
      current = null;
      const d = line.match(/^(defaultAccount|defaultPortal):\s*(.+)$/);
      if (d) defaultAccount = unquote(d[2]);
      continue;
    }
    if (!inList) continue;

    let rest = line.slice(indent);
    if (rest.startsWith("- ")) {
      current = {};
      accounts.push(current);
      itemIndent = indent + 2;
      rest = rest.slice(2);
    } else if (!current || indent !== itemIndent) {
      continue; // nested under auth:, tokenInfo:, etc.
    }

    const kv = rest.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2];
    if (/^[>|][-+]?$/.test(value.trim())) {
      // Block scalar: the value is the following, more-indented lines.
      const parts = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || indentOf(lines[i + 1]) > itemIndent)) {
        i++;
        if (lines[i].trim()) parts.push(lines[i].trim());
      }
      value = parts.join(value.trim().startsWith(">") ? " " : "\n");
    }
    current[kv[1]] = unquote(value);
  }
  return { defaultAccount, accounts };
}

// The default account's { personalAccessKey, accountId, name }, or null.
function pickAccount({ defaultAccount, accounts }) {
  const withKey = accounts.filter((a) => a.personalAccessKey);
  const idOf = (a) => a.accountId || a.portalId;
  const chosen = (defaultAccount && withKey.find((a) => a.name === defaultAccount || idOf(a) === defaultAccount)) || withKey[0];
  if (!chosen || !/^\d+$/.test(idOf(chosen) || "")) return null;
  return { personalAccessKey: chosen.personalAccessKey, accountId: Number(idOf(chosen)), name: chosen.name || null };
}

function candidatePaths({ home = os.homedir(), repoRoot = path.join(__dirname, "..") } = {}) {
  return [path.join(home, ".hscli", "config.yml"), path.join(repoRoot, "hubspot.config.yml")];
}

/**
 * The first config file that exists, parsed. Throws with a message naming
 * every path tried when there is none, or when it has no usable account.
 */
function readHubspotCliConfig(opts = {}) {
  const paths = candidatePaths(opts);
  const file = paths.find((p) => fs.existsSync(p));
  if (!file) {
    throw new Error(
      `No HubSpot CLI config found. Looked in:\n${paths.map((p) => `  ${p}`).join("\n")}\n` +
      "Run `npx hs account auth` (CLI v8) to create one."
    );
  }
  const account = pickAccount(parseConfig(fs.readFileSync(file, "utf8")));
  if (!account) {
    throw new Error(`${file} has no account with a personalAccessKey and accountId. Run \`npx hs account auth\`.`);
  }
  return { ...account, file };
}

module.exports = { parseConfig, pickAccount, candidatePaths, readHubspotCliConfig };
