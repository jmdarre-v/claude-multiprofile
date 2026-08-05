// `claude-multiprofile list` - print the user's Claude landscape.
//
// Two sections:
//   1. The default Claude install (if detected on this machine). These are
//      the apps the user already had before installing this tool.
//   2. Additional profiles created via `claude-multiprofile add`. These
//      are isolated installs that run alongside the default.
//
// Showing both makes the output meaningful even on first run, when the
// registry is empty -- the user can confirm "yes, my regular Claude is
// detected, and I haven't added any additional profiles yet". Without
// the default section, an empty registry just says "nothing here" and
// can feel like the tool is broken.

import { getRegistry, registryLocation } from "../registry.js";
import { detectDefaults } from "../detect.js";
import { resolveClaude } from "../claudebin.js";
import { header, info, warn, pathStr, tildify, command, dim } from "../util.js";

export async function list() {
  header("Claude installs and profiles");

  const defaults = detectDefaults();
  const reg = getRegistry();

  // ---- Section 1: default install ----------------------------------------

  if (defaults.desktop || defaults.code) {
    console.log(`  ${pathStr("default")} ${dim("(your existing Claude install, not managed by this tool)")}`);
    if (defaults.desktop) {
      console.log(`    Desktop data:    ${tildify(defaults.desktop.dataDir)}`);
      console.log(`    Desktop app:     ${defaults.desktop.appPath}`);
    }
    if (defaults.code) {
      console.log(`    Code config:     ${tildify(defaults.code.configDir)}`);
    }
    console.log("");
  } else {
    console.log("  " + dim("No default Claude install detected on this machine."));
    console.log("");
  }

  // ---- The shared `claude` binary ----------------------------------------
  //
  // Every profile runs the SAME `claude` binary; only the config dir differs.
  // So which copy wins on PATH affects all of them at once, and a shadowed
  // duplicate is a common cause of "my profile is on an old version".

  const bin = resolveClaude();
  if (bin.found) {
    console.log(`  ${pathStr("claude binary")} ${dim("(shared by all profiles)")}`);
    console.log(`    Path:            ${tildify(bin.winner)}`);
    console.log(`    Version:         ${bin.version || dim("unknown")}`);
    if (bin.shadowed.length > 0) {
      console.log(
        `    ${dim(`Also on PATH (shadowed): ${bin.shadowed.map(tildify).join(", ")}`)}`
      );
    }
    console.log("");
  } else {
    warn("No `claude` binary found on PATH. Claude Code profiles won't launch.");
    console.log("");
  }

  // ---- Section 2: additional profiles ------------------------------------

  if (reg.profiles.length === 0) {
    info("No additional profiles configured yet.");
    info(`Run ${command("claude-multiprofile add")} to create one.`);
    return;
  }

  console.log(`  ${dim("Additional profiles managed by claude-multiprofile:")}\n`);
  for (const p of reg.profiles) {
    console.log(`  ${pathStr(p.name)} (${p.type})`);
    if (p.desktop) {
      console.log(`    Desktop data:    ${tildify(p.desktop.dataDir)}`);
      console.log(`    Desktop launcher: ${tildify(p.desktop.appPath)}`);
    }
    if (p.code) {
      console.log(`    Code config:     ${tildify(p.code.configDir)}`);
      console.log(`    Code alias:      ${p.code.aliasName}`);
    }
    console.log(`    Created:         ${p.createdAt.split("T")[0]}`);
    console.log("");
  }

  info(`Registry file: ${pathStr(tildify(registryLocation()))}`);
}
