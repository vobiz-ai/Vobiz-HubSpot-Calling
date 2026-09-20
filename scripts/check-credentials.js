const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const sensitivePatterns = [
  /SA_[A-Z0-9]{8}/i,
  /[a-f0-9]{64}/i,
  /tunnelmole\.net/i,
  /trycloudflare\.com/i,
];

const ignoredDirs = ["node_modules", ".git", "dist", "bin", "scratch"];

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let violations = 0;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.includes(entry.name)) {
        violations += scanDirectory(fullPath);
      }
    } else if (entry.isFile()) {
      if (entry.name === ".env" || entry.name === "tunnel-url.txt" || entry.name.endsWith(".png") || entry.name.endsWith(".jpg")) {
        continue;
      }
      const content = fs.readFileSync(fullPath, "utf8");
      for (const pattern of sensitivePatterns) {
        if (pattern.test(content)) {
          // Check if it's in example files or comments explicitly stating it's an example
          if (entry.name.includes("example") || content.includes("YOUR_VOBIZ")) {
            continue;
          }
          console.error(`⚠️ Security Alert: Potential hardcoded secret found in ${path.relative(rootDir, fullPath)}`);
          violations++;
        }
      }
    }
  }
  return violations;
}

console.log("🔍 Scanning VoBiz HubSpot repository for hardcoded credentials...");
const issues = scanDirectory(rootDir);

if (issues === 0) {
  console.log("✅ Security Audit Passed: Zero hardcoded credentials or developer tunnel URLs found!");
  process.exit(0);
} else {
  console.error(`❌ Security Audit Failed: Found ${issues} potential hardcoded secret(s). Clean them before pushing to GitHub.`);
  process.exit(1);
}
