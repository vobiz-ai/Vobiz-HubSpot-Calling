/**
 * Where the backend keeps its runtime state, and how it reads and writes it.
 *
 * State lives in DATA_DIR (default backend/data, created 0700). Each file is
 * written 0600, atomically (temp file + rename), so a crash mid-write never
 * leaves half a JSON document behind.
 *
 * Older versions wrote these files straight into backend/. When the new file
 * does not exist yet but the old one does, the old one is read; the next write
 * lands in DATA_DIR.
 */
const fs = require("node:fs");
const path = require("node:path");

const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");

// A relative DATA_DIR is taken relative to backend/, not to the shell's cwd,
// so `npm start` from the repo root and `node server.js` from backend/ agree.
function resolveDataDir(env = process.env, backendDir = __dirname) {
  const v = clean(env.DATA_DIR);
  return v ? path.resolve(backendDir, v) : path.join(backendDir, "data");
}

function ensureDir(dir) {
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is filtered by the umask; set it explicitly on what we made.
  if (created) fs.chmodSync(dir, 0o700);
}

// Reads `file`, or `legacyFile` when `file` does not exist yet. Returns null
// when neither holds valid JSON.
function readJson(file, legacyFile) {
  const source = !fs.existsSync(file) && legacyFile && fs.existsSync(legacyFile) ? legacyFile : file;
  try { return JSON.parse(fs.readFileSync(source, "utf8")); } catch { return null; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

module.exports = { resolveDataDir, ensureDir, readJson, writeJson };
