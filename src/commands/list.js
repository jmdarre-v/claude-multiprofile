// `claude-profiles list` - print configured profiles in a readable format.
//
// Pulls straight from the registry. We don't check filesystem existence
// here; that's `status`'s job. List is for "what did I configure?".

import { getRegistry, registryLocation } from "../registry.js";
import { header, info, pathStr, tildify, command } from "../util.js";

export async function list() {
  header("Configured Claude profiles");

  const reg = getRegistry();
  if (reg.profiles.length === 0) {
    console.log("  No profiles configured yet.\n");
    info(`Run ${command("claude-profiles add")} to create one.`);
    return;
  }

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
