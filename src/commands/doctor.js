// `claude-multiprofile doctor` - diagnose the whole setup.
//
// `status` answers "is each profile's paperwork in order?" It walks the
// registry and checks that the files it references exist. `doctor` answers a
// different question: "is this MACHINE in a state where profiles will behave?"
//
// The difference matters because the nastiest failures live outside the
// registry entirely:
//
//   - Two `claude` binaries on PATH, and the one that wins isn't the one you
//     upgraded. Every profile silently runs the old version.
//   - A broken/partial npm install (a package dir with node_modules but no
//     package.json and no bin symlink) that de-registers the binary and lets
//     PATH fall through to an older copy.
//   - A profile whose directory collides with another tool's data.
//   - Cross-profile read protection (issue #4) that has drifted out of sync
//     because profiles were added or removed by an older version.
//
// doctor is read-only by default. `--fix` repairs the things that are safe to
// repair automatically (currently: deny-rule drift).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getRegistry, registryLocation, registryHealth } from "../registry.js";
import { detectDefaults } from "../detect.js";
import { resolveClaude } from "../claudebin.js";
import {
  getBundleId,
  setBundleId,
  uniqueBundleId,
  launcherCodeConfigDir,
  compileApp,
  copyClaudeIcon,
  DEFAULT_APPLET_BUNDLE_ID,
} from "../desktop.js";
import { DEFAULT_CLAUDE_CONFIG_DIR } from "../code.js";
import { resyncDenyRules, auditDenyRules } from "../permissions.js";
import { detectShell, rcPathForShell, readManagedAliases } from "../shell.js";
import {
  HOME,
  header,
  ok,
  warn,
  err,
  info,
  step,
  pathStr,
  tildify,
  fileExists,
  command,
  dim,
  isMac,
  compareVersions,
} from "../util.js";

const PKG_NAME = "claude-multiprofile";

// Directories under $HOME that belong to other tools in the Claude ecosystem.
// A profile pointing at one of these is a data-loss risk on `remove`.
const FOREIGN_DIRS = {
  ".claude-mem": "claude-mem",
  ".claude-profiles": "claude-profiles",
  ".claude-multiprofile": "this tool's own config",
};

// Tally of problems so we can print an accurate summary at the end.
function makeTally() {
  return { problems: 0, warnings: 0 };
}

// ---- Check: the shared claude binary ---------------------------------------

function checkClaudeBinary(t) {
  step("Claude Code binary");

  const bin = resolveClaude();
  if (!bin.found) {
    err("No `claude` on PATH.");
    info("Claude Code profiles cannot launch. Install Claude Code, then re-run.");
    t.problems++;
    return;
  }

  ok(`Resolved: ${tildify(bin.winner)}`);
  info(`Version:  ${bin.version || "unknown"}`);

  if (bin.shadowed.length > 0) {
    // More than one copy is not automatically wrong (nvm users often have one
    // per Node version), but it IS the single most common cause of "I
    // upgraded and nothing changed", so we always surface it.
    warn(
      `${bin.shadowed.length} additional \`claude\` on PATH, shadowed by the one above:`
    );
    for (const p of bin.shadowed) console.log(`      ${dim(tildify(p))}`);
    info("If the winning version looks stale, the shadowed copy may be the one you upgraded.");
    t.warnings++;
  }
}

// ---- Check: broken/partial npm installs ------------------------------------
//
// The failure we actually hit: an npm package directory left with
// node_modules/ (and/or vendor/) but no package.json. npm no longer treats it
// as installed, the bin symlink disappears, and PATH quietly falls through to
// a different copy. Detect it by inspecting the global root.

function globalNodeModules() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}

function checkBrokenInstalls(t) {
  step("npm install integrity");

  const root = globalNodeModules();
  if (!root || !fileExists(root)) {
    info("Could not determine the global npm root; skipping this check.");
    return;
  }

  // Only inspect the packages we care about: Claude Code and this tool.
  const suspects = [
    path.join(root, "@anthropic-ai", "claude-code"),
    path.join(root, PKG_NAME),
  ];

  let found = false;
  for (const dir of suspects) {
    if (!fileExists(dir)) continue;
    found = true;
    const manifest = path.join(dir, "package.json");
    if (!fileExists(manifest)) {
      err(`Broken install: ${tildify(dir)}`);
      info("  The directory exists but has no package.json.");
      info("  npm won't treat it as installed and its command may vanish from PATH.");
      info(`  Fix: ${command(`npm install -g ${path.basename(dir)}@latest --force`)}`);
      t.problems++;
    } else {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        ok(`${pkg.name || path.basename(dir)} ${pkg.version || ""} install looks intact.`);
      } catch {
        warn(`${tildify(dir)}: package.json is unreadable or malformed.`);
        t.warnings++;
      }
    }
  }

  if (!found) {
    info("Neither Claude Code nor this tool is installed in the global npm root.");
    info(dim("  (Normal if you installed via Homebrew, a version manager, or run via npx.)"));
  }
}

// ---- Check: this tool's own version ----------------------------------------

function checkOwnVersion(t, currentVersion) {
  step("claude-multiprofile version");
  info(`Installed: ${currentVersion}`);

  let latest = null;
  try {
    latest = execFileSync("npm", ["view", PKG_NAME, "version"], {
      encoding: "utf8",
      timeout: 20_000,
    }).trim();
  } catch {
    info("Could not reach the npm registry to check for updates (offline?).");
    return;
  }

  const cmp = compareVersions(currentVersion, latest);
  if (cmp < 0) {
    warn(`A newer version is available: ${latest}`);
    info(`Upgrade with ${command("claude-multiprofile upgrade")}`);
    t.warnings++;
  } else if (cmp > 0) {
    info(`Ahead of npm (${latest} published): running an unreleased build.`);
  } else {
    ok("Up to date.");
  }
}

// ---- Check: profile directories & collisions -------------------------------

function checkProfiles(t, reg) {
  step("Profiles");

  if (reg.profiles.length === 0) {
    info("No profiles configured.");
    return;
  }

  const shell = detectShell();
  const aliasNames = new Set(readManagedAliases(shell).map((a) => a.name));

  // Detect two profiles pointing at the same directory, which is a genuine
  // conflict where each would clobber the other's state.
  const dirOwners = new Map();

  for (const p of reg.profiles) {
    console.log("");
    console.log(`  ${pathStr(p.name)} ${dim(`(${p.type})`)}`);

    const dirs = [];
    if (p.code && p.code.configDir) dirs.push(["Code config", p.code.configDir]);
    if (p.desktop && p.desktop.dataDir) dirs.push(["Desktop data", p.desktop.dataDir]);
    if (p.desktop && p.desktop.appPath) dirs.push(["Launcher", p.desktop.appPath]);

    for (const [label, dir] of dirs) {
      if (fileExists(dir)) {
        console.log(`    ✓ ${label}: ${tildify(dir)}`);
      } else {
        console.log(`    ✗ ${label}: ${tildify(dir)} ${dim("(missing)")}`);
        t.problems++;
      }

      // Foreign-directory collision: is this profile squatting on another
      // tool's data? Deleting the profile would take that tool's data with it.
      const base = path.basename(dir);
      if (FOREIGN_DIRS[base] && dir === path.join(HOME, base)) {
        err(`      Collision: this is ${FOREIGN_DIRS[base]}'s directory.`);
        info("      `remove` on this profile would offer to delete it. Consider renaming the profile.");
        t.problems++;
      }

      // Same-directory conflict between two profiles.
      if (label !== "Launcher") {
        const prev = dirOwners.get(dir);
        if (prev && prev !== p.name) {
          err(`      Conflict: also used by profile "${prev}".`);
          t.problems++;
        }
        dirOwners.set(dir, p.name);
      }
    }

    if (p.code && p.code.aliasName) {
      if (aliasNames.has(p.code.aliasName)) {
        console.log(`    ✓ Alias "${p.code.aliasName}" present in ${tildify(rcPathForShell(shell))}`);
      } else {
        console.log(`    ✗ Alias "${p.code.aliasName}" missing from ${tildify(rcPathForShell(shell))}`);
        t.problems++;
      }
    }
  }
}

// ---- Check: launcher bundle IDs --------------------------------------------
//
// The v0.1.9 bug class: every osacompile'd launcher shares the default
// AppleScript bundle identifier, so LaunchServices treats all profile
// launchers as the same app and Dock double-clicks stop resolving. Profiles
// created before v0.1.9 still carry the default ID unless `repair` was run.
// This check finds them; --fix restamps and re-registers on the spot.

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function checkLauncherBundleIds(t, reg, fix) {
  if (!isMac()) return;
  const launchers = reg.profiles.filter(
    (p) => p.desktop && p.desktop.appPath && fileExists(p.desktop.appPath)
  );
  if (launchers.length === 0) return;

  step("Launcher bundle IDs");

  for (const p of launchers) {
    const id = getBundleId(p.desktop.appPath);
    if (id === null) {
      warn(`${p.name}: could not read the launcher's Info.plist.`);
      t.warnings++;
      continue;
    }
    if (id !== DEFAULT_APPLET_BUNDLE_ID) {
      ok(`${p.name}: ${dim(id)}`);
      continue;
    }
    // Still on the colliding default.
    warn(`${p.name}: launcher still has the default AppleScript bundle ID.`);
    info("  With two or more launchers like this, Dock double-clicks can stop working.");
    if (fix) {
      const newId = uniqueBundleId(p.name);
      if (setBundleId(p.desktop.appPath, newId)) {
        try {
          execFileSync(LSREGISTER, ["-f", p.desktop.appPath], { stdio: "pipe" });
        } catch {
          // Restamping alone still fixes the collision on next registration.
        }
        ok(`  Repaired: restamped as ${newId} and re-registered.`);
      } else {
        err("  Could not rewrite the bundle ID.");
        t.problems++;
      }
    } else {
      info(`  Repair with ${command("claude-multiprofile doctor --fix")} or ${command(`claude-multiprofile repair ${p.name}`)}`);
      t.warnings++;
    }
  }
}

// ---- Check: launchers export CLAUDE_CONFIG_DIR ------------------------------
//
// v0.1.12 started passing `--env CLAUDE_CONFIG_DIR=...` in the launch line so
// Claude Code sessions spawned from inside Desktop stay in the profile instead
// of falling back to the shared ~/.claude. Launchers built before that keep
// their old line, and the symptom is invisible: Desktop is isolated, the
// launcher works, and only the CLI half quietly merges. This finds them.
//
// Only profiles with BOTH a Desktop launcher and a Code target need the flag.

function checkLauncherEnv(t, reg, fix) {
  if (!isMac()) return;
  const candidates = reg.profiles.filter(
    (p) =>
      p.desktop &&
      p.desktop.appPath &&
      fileExists(p.desktop.appPath) &&
      p.code &&
      p.code.configDir
  );
  // Desktop profiles with no Code target at all. Not a fault (Desktop-only is
  // a legitimate choice), but it surprises people: Claude Code opened from
  // inside such a profile uses the shared ~/.claude, so it is worth naming.
  // Informational only, so it stays out of the problem and warning tallies.
  const desktopOnly = reg.profiles.filter((p) => p.desktop && !p.code);

  if (candidates.length === 0 && desktopOnly.length === 0) return;

  step("Desktop-spawned Claude Code");

  for (const p of desktopOnly) {
    info(`${p.name}: Desktop only, so Claude Code opened inside it uses ${tildify(DEFAULT_CLAUDE_CONFIG_DIR)}.`);
    console.log(
      `      ${dim(`Give it its own with ${command("claude-multiprofile add")}, choosing Claude Code and the name "${p.name}".`)}`
    );
  }

  for (const p of candidates) {
    const current = launcherCodeConfigDir(p.desktop.appPath);
    const expected = p.code.configDir;

    if (current === undefined) {
      warn(`${p.name}: could not read the launcher's script.`);
      t.warnings++;
      continue;
    }
    if (current === expected) {
      ok(`${p.name}: launcher exports ${dim(tildify(expected))}`);
      continue;
    }

    if (current === null) {
      warn(`${p.name}: launcher does not set CLAUDE_CONFIG_DIR.`);
      info("  Claude Code started from inside this Desktop profile will use the");
      info(`  shared ${tildify(DEFAULT_CLAUDE_CONFIG_DIR)} instead of the profile's own config.`);
    } else {
      warn(`${p.name}: launcher exports a stale config dir.`);
      info(`  Launcher says: ${tildify(current)}`);
      info(`  Profile wants: ${tildify(expected)}`);
    }

    if (!fix) {
      info(`  Repair with ${command("claude-multiprofile doctor --fix")}`);
      t.warnings++;
      continue;
    }

    // Rebuilding replaces the bundle, so the icon and bundle ID have to be
    // reapplied and LaunchServices re-informed, same as `rename` does.
    if (!fileExists(p.desktop.claudeAppPath)) {
      err(`  Cannot rebuild: Claude.app not found at ${p.desktop.claudeAppPath}`);
      t.problems++;
      continue;
    }
    try {
      compileApp({
        name: p.name,
        dataDir: p.desktop.dataDir,
        appPath: p.desktop.appPath,
        claudeAppPath: p.desktop.claudeAppPath,
        codeConfigDir: expected,
      });
      copyClaudeIcon(p.desktop.appPath, p.desktop.claudeAppPath);
      try {
        execFileSync(LSREGISTER, ["-f", p.desktop.appPath], { stdio: "pipe" });
      } catch {
        // Non-fatal: the rebuilt bundle still works, registration catches up.
      }
      ok(`  Repaired: launcher rebuilt and now exports ${tildify(expected)}`);
    } catch (e) {
      err(`  Could not rebuild the launcher: ${e.message}`);
      info(`  Recreate it with ${command("claude-multiprofile add")} using the same name and paths.`);
      t.problems++;
    }
  }
}

// ---- Check: cross-profile read protection (issue #4) -----------------------

function checkDenyRules(t, reg, fix) {
  step("Cross-profile read protection");

  const findings = auditDenyRules(reg);
  if (findings.length === 0) {
    info("Not applicable (needs two or more profiles, at least one of them Code).");
    return;
  }

  const drifted = findings.filter((f) => f.missing.length > 0);
  if (drifted.length === 0) {
    ok("Every Code profile blocks reads of the others' directories.");
    return;
  }

  for (const f of drifted) {
    warn(`${f.name}: ${f.missing.length} of ${f.expected} deny rule(s) missing.`);
    console.log(`      ${dim(tildify(f.settingsPath))}`);
    if (f.symlink) {
      // --fix can't help here: writing is exactly what we refuse to do.
      info("      Its settings.json is a symlink out of the profile, so rules are not written.");
      if (f.target) info(`      It points at ${tildify(f.target)}`);
      info("      Replace the link with a real file to get read protection for this profile.");
    } else if (f.malformed) {
      info("      Its settings.json is not valid JSON, so it was left untouched.");
    }
  }

  // A symlinked or malformed settings.json is not repairable by rewriting it.
  const repairable = drifted.filter((f) => !f.symlink && !f.malformed);
  if (fix && repairable.length === 0) {
    warn("Nothing here is safe to repair automatically. See the notes above.");
    t.warnings++;
  } else if (fix) {
    resyncDenyRules(reg, { verbose: false });
    ok("Repaired: deny rules rewritten from the registry.");
  } else {
    info(`Repair with ${command("claude-multiprofile doctor --fix")}`);
    t.warnings++;
  }
}

// ---- Top-level -------------------------------------------------------------

export async function doctor(args = []) {
  header("claude-multiprofile doctor");

  const fix = args.includes("--fix");
  const t = makeTally();
  const reg = getRegistry();

  // Version of this tool, read the same way cli.js does.
  let currentVersion = "unknown";
  try {
    const pkgPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "package.json"
    );
    currentVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch {
    // Non-fatal; the version check will just report "unknown".
  }

  // A corrupt registry first: every later check reads from it, and a corrupt
  // file otherwise masquerades as "no profiles configured".
  if (registryHealth().state === "corrupt") {
    step("Registry");
    err(`${tildify(registryLocation())} exists but is not valid JSON.`);
    info("Profiles are configured but can't be read. Mutating commands will refuse to run.");
    info(`Fix the JSON by hand; a last-known-good copy may exist at ${tildify(registryLocation())}.bak`);
    t.problems++;
  }

  checkClaudeBinary(t);
  checkBrokenInstalls(t);
  checkOwnVersion(t, currentVersion);
  checkProfiles(t, reg);
  checkLauncherBundleIds(t, reg, fix);
  checkLauncherEnv(t, reg, fix);
  checkDenyRules(t, reg, fix);

  // ---- Summary -------------------------------------------------------------

  console.log("");
  const defaults = detectDefaults();
  info(`Registry: ${pathStr(tildify(registryLocation()))}`);
  info(
    `Default Claude: Desktop ${defaults.desktop ? "detected" : "not detected"}, Code ${
      defaults.code ? "detected" : "not detected"
    }`
  );

  console.log("");
  if (t.problems === 0 && t.warnings === 0) {
    ok("No problems found.");
  } else {
    if (t.problems > 0) err(`${t.problems} problem${t.problems === 1 ? "" : "s"} found.`);
    if (t.warnings > 0) warn(`${t.warnings} warning${t.warnings === 1 ? "" : "s"}.`);
  }
}
