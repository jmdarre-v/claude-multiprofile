// `upgrade` command.
//
// Upgrades the globally installed claude-multiprofile package to the latest
// version on npm, then applies that version's changes to your profiles, in one
// step. We delegate the install to npm itself rather than reinventing it,
// since npm already knows the user's global prefix, permissions, and registry
// config. If the user installed via another mechanism (Homebrew, npx, a
// clone), npm's own error output is the right thing to surface.
//
// Why the second half exists: installing replaces the code and nothing else.
// The launch helper, rebuilt launchers, and moving profiles over to a new way
// of working all happen in `doctor --fix` (see src/state.js). Two steps meant
// the second was easy to miss, and when the first quietly went wrong, the
// second ran on the old version and reported "No problems found".

import { spawnSync } from "node:child_process";
import { header, info, ok, warn, err, command, dim, tildify, compareVersions } from "../util.js";
import { resolveBinaries } from "../claudebin.js";
import { getRegistry } from "../registry.js";
import { fixPassDue, readState, toolVersion } from "../state.js";
import { doctor } from "./doctor.js";

const PKG_NAME = "claude-multiprofile";

function fetchLatest() {
  // --prefer-online: ask the registry, not npm's local cache, which can hold
  // an older "latest" for several minutes after a release.
  const res = spawnSync("npm", ["view", PKG_NAME, "version", "--prefer-online"], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

// Install the exact version we looked up, not @latest. Resolving "latest" a
// second time is what went wrong on v0.1.29: `npm view` asked the registry and
// saw 0.1.29, then `npm install @latest` answered from its cache and installed
// 0.1.28 again.
export function installArgs(version) {
  return ["install", "-g", `${PKG_NAME}@${version}`, "--prefer-online"];
}

// What npm itself has in its global folder, independent of what PATH finds.
// Telling these apart is the difference between "npm installed the wrong
// version" and "npm installed it where your shell does not look".
function npmGlobalVersion() {
  const res = spawnSync("npm", ["ls", "-g", PKG_NAME, "--depth=0", "--json"], { encoding: "utf8" });
  try {
    return JSON.parse(res.stdout).dependencies[PKG_NAME].version || null;
  } catch {
    return null;
  }
}

// Run a version's `doctor --fix`. The newly installed version has to run as
// its own process: this one is still the old code, and its doctor does not
// know what the new version changed.
function applyFixes(binary, version) {
  console.log("");
  header(`Applying ${version}'s changes to your profiles`);
  const r = spawnSync(binary, ["doctor", "--fix"], { stdio: "inherit" });
  if (r.status !== 0) {
    warn(`doctor --fix exited with status ${r.status}. Run ${command("claude-multiprofile doctor")} to see what is left.`);
  }
}

export async function upgrade(args = []) {
  header("Upgrade claude-multiprofile");

  const skipFixes = args.includes("--no-fix");
  const current = toolVersion();
  info(`Installed version: ${current}`);

  const latest = fetchLatest();
  if (!latest) {
    err("Could not reach the npm registry to check for the latest version.");
    console.log(dim("  Check your network connection and try again."));
    process.exit(1);
  }
  info(`Latest on npm:     ${latest}`);
  console.log("");

  const cmp = compareVersions(current, latest);
  if (cmp >= 0) {
    if (cmp === 0) ok("You're already on the latest version.");
    else info(`You're ahead of npm (${latest} published): running an unreleased build.`);
    // Already current, but maybe never applied: installed with plain npm, or
    // an earlier upgrade stopped between the two steps.
    if (fixPassDue(current, getRegistry().profiles.length, readState().fixesAppliedFor)) {
      if (skipFixes) {
        info(`Its changes have not been applied to your profiles. Run ${command("claude-multiprofile doctor --fix")} when ready.`);
        return;
      }
      info("Its changes have not been applied to your profiles yet; applying them now.");
      console.log("");
      await doctor(["--fix"]);
    }
    return;
  }

  const args2 = installArgs(latest);
  console.log(`Running ${command(`npm ${args2.join(" ")}`)}\n`);
  const install = spawnSync("npm", args2, { stdio: "inherit" });

  if (install.status !== 0) {
    console.log("");
    err("Upgrade failed. See npm output above.");
    console.log(dim("  If you installed via Homebrew or another package manager,"));
    console.log(dim("  upgrade through that tool instead."));
    process.exit(install.status || 1);
  }
  console.log("");

  // ---- Verify the upgrade actually took ------------------------------------

  const installed = npmGlobalVersion();
  if (installed && installed !== latest) {
    err(`npm installed ${installed}, not ${latest}.`);
    info("This happens in the minutes after a release, while npm is still processing it.");
    info(`Wait a minute and run ${command("claude-multiprofile upgrade")} again.`);
    process.exit(1);
  }

  // The other trap: with several Node versions installed (nvm etc.), npm
  // installs into the CURRENT version's global directory, but PATH may serve
  // the command from a DIFFERENT one. The install succeeds while the command
  // everyone runs stays old.
  const copies = resolveBinaries(PKG_NAME);
  if (copies.length === 0) {
    ok(`Upgraded ${PKG_NAME} ${current} → ${latest}`);
    info(`Run ${command("claude-multiprofile doctor --fix")} to apply its changes to your profiles.`);
    return;
  }
  const reported = spawnSync(copies[0], ["--version"], { encoding: "utf8", timeout: 15_000 });
  const winnerVersion = reported.status === 0 ? reported.stdout.trim() : null;

  if (winnerVersion !== latest) {
    ok(`npm installed ${PKG_NAME} ${latest}.`);
    warn(`But the ${PKG_NAME} your shell runs still reports ${winnerVersion || "nothing"}.`);
    info(`Winning copy: ${tildify(copies[0])}`);
    if (copies.length > 1) {
      info("Other copies on PATH:");
      for (const p of copies.slice(1)) console.log(`      ${dim(tildify(p))}`);
    }
    info("The upgrade landed in a different Node version's global directory.");
    info(`Its changes were not applied: fix PATH first, then run ${command("claude-multiprofile doctor --fix")}.`);
    return;
  }

  ok(`Upgraded ${PKG_NAME} ${current} → ${latest}, verified at ${tildify(copies[0])}.`);
  if (skipFixes) {
    info(`Run ${command("claude-multiprofile doctor --fix")} when you're ready to apply its changes.`);
    return;
  }
  if (getRegistry().profiles.length === 0) return;
  applyFixes(copies[0], latest);
}
