// `upgrade` command.
//
// Upgrades the globally installed claude-multiprofile package to the latest
// version published on npm. We delegate to npm itself rather than reinventing
// the install — npm already knows about the user's global prefix, permissions,
// and registry config.
//
// We do this for the convenience of users who installed via `npm i -g` and
// don't want to remember the package name or where it lives. If the user
// installed via another mechanism (Homebrew, npx-on-demand, a clone), npm's
// own error output is the right thing to surface.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { header, info, ok, err, command, dim } from "../util.js";

const PKG_NAME = "claude-multiprofile";

function currentVersion() {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf8")).version;
}

function fetchLatest() {
  const res = spawnSync("npm", ["view", PKG_NAME, "version"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

export async function upgrade() {
  header("Upgrade claude-multiprofile");

  const current = currentVersion();
  info(`Installed version: ${current}`);

  const latest = fetchLatest();
  if (!latest) {
    err("Could not reach the npm registry to check for the latest version.");
    console.log(dim("  Check your network connection and try again."));
    process.exit(1);
  }
  info(`Latest on npm:     ${latest}`);
  console.log("");

  if (current === latest) {
    ok("You're already on the latest version. Nothing to do.");
    return;
  }

  console.log(`Running ${command(`npm install -g ${PKG_NAME}@latest`)}\n`);
  const install = spawnSync("npm", ["install", "-g", `${PKG_NAME}@latest`], {
    stdio: "inherit",
  });

  if (install.status !== 0) {
    console.log("");
    err("Upgrade failed. See npm output above.");
    console.log(dim("  If you installed via Homebrew or another package manager,"));
    console.log(dim("  upgrade through that tool instead."));
    process.exit(install.status || 1);
  }

  console.log("");
  ok(`Upgraded ${PKG_NAME} ${current} → ${latest}`);
}
