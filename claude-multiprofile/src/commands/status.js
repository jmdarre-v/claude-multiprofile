// `claude-multiprofile status` - sanity-check what's configured.
//
// Walks the registry and the detected default install and verifies that
// the things that should exist actually exist on disk and in the shell
// config. Useful after a machine migration, after manually mucking with
// your .zshrc, or just to confirm a fresh install is healthy.

import { getRegistry, registryLocation } from "../registry.js";
import { detectDefaults } from "../detect.js";
import {
  detectShell,
  rcPathForShell,
  readManagedAliases,
} from "../shell.js";
import {
  header,
  ok,
  warn,
  info,
  pathStr,
  tildify,
  fileExists,
  command,
  dim,
} from "../util.js";

export async function status() {
  header("Claude profiles status");

  const defaults = detectDefaults();
  const reg = getRegistry();
  const shell = detectShell();
  const aliasNames = new Set(readManagedAliases(shell).map((a) => a.name));

  // ---- Default install -----------------------------------------------------

  console.log(`  ${pathStr("default")} ${dim("(existing Claude install, not managed by this tool)")}`);
  if (defaults.desktop) {
    console.log(`    ✓ Desktop app:    ${defaults.desktop.appPath}`);
    console.log(`    ✓ Desktop data:   ${tildify(defaults.desktop.dataDir)}`);
  } else {
    console.log("    " + dim("Claude Desktop: not detected (either not installed or never launched)"));
  }
  if (defaults.code) {
    console.log(`    ✓ Code config:    ${tildify(defaults.code.configDir)}`);
  } else {
    console.log("    " + dim("Claude Code: not detected (either not installed or never launched)"));
  }
  console.log("");

  // ---- Additional profiles -------------------------------------------------

  if (reg.profiles.length === 0) {
    info("No additional profiles configured.");
    info(`Run ${command("claude-multiprofile add")} to create one.`);
    return;
  }

  console.log(`  ${dim("Additional profiles managed by claude-multiprofile:")}\n`);
  for (const p of reg.profiles) {
    console.log(`  ${pathStr(p.name)} (${p.type})`);
    let issues = 0;

    if (p.desktop) {
      const dataOk = fileExists(p.desktop.dataDir);
      const appOk = fileExists(p.desktop.appPath);
      const claudeOk = fileExists(p.desktop.claudeAppPath);

      console.log(
        `    ${dataOk ? "✓" : "✗"} Desktop data folder: ${tildify(p.desktop.dataDir)}`
      );
      if (!dataOk) issues++;

      console.log(
        `    ${appOk ? "✓" : "✗"} Launcher app: ${tildify(p.desktop.appPath)}`
      );
      if (!appOk) issues++;

      console.log(
        `    ${claudeOk ? "✓" : "✗"} Claude.app source: ${p.desktop.claudeAppPath}`
      );
      if (!claudeOk) issues++;
    }

    if (p.code) {
      const cfgOk = fileExists(p.code.configDir);
      const aliasOk = aliasNames.has(p.code.aliasName);

      console.log(
        `    ${cfgOk ? "✓" : "✗"} Code config folder: ${tildify(p.code.configDir)}`
      );
      if (!cfgOk) issues++;

      console.log(
        `    ${aliasOk ? "✓" : "✗"} Shell alias "${p.code.aliasName}" in ${tildify(rcPathForShell(shell))}`
      );
      if (!aliasOk) issues++;
    }

    if (issues === 0) {
      ok(`    All checks passed.`);
    } else {
      warn(`    ${issues} issue${issues > 1 ? "s" : ""} detected.`);
      info(
        `    Re-run ${command(`claude-multiprofile add`)} for this profile, or fix manually.`
      );
    }
    console.log("");
  }

  info(`Registry: ${pathStr(tildify(registryLocation()))}`);
  info(`Shell: ${shell} (${pathStr(tildify(rcPathForShell(shell)))})`);
}
