// `claude-multiprofile self-update [name] [on|off]` - who updates a profile's
// copy of Claude.
//
//   off (the default)  The copy's own updater is blocked, and the launcher
//                      rebuilds the copy from /Applications/Claude.app on the
//                      first click after that updates. See src/updates.js.
//   on                 Claude updates the copy itself, as it did before
//                      v0.1.29. Every such update relaunches the copy on the
//                      default account and removes its colour, which is why
//                      this is not the default.

import { getRegistry, findProfile, replaceProfile } from "../registry.js";
import { updateBlockState, blockUpdates, unblockUpdates, wantsUpdateBlock } from "../updates.js";
import { header, ok, warn, err, info, command, pathStr } from "../util.js";

function describe(p) {
  const s = updateBlockState(p.desktop.dataDir);
  if (!wantsUpdateBlock(p)) return "on: Claude updates this copy itself";
  if (s.state === "blocked") return "off: its launcher keeps it current";
  if (s.state === "foreign") return "its own Claude configuration is in charge (left alone)";
  return "off, but not in place yet: run `claude-multiprofile doctor --fix`";
}

export async function selfUpdate(args) {
  header("Profile self-updates");

  const reg = getRegistry();
  const desktops = reg.profiles.filter((p) => p.desktop);
  const [name, choice] = args;

  if (!name) {
    if (desktops.length === 0) {
      info("No Desktop profiles configured.");
      return;
    }
    for (const p of desktops) console.log(`  ${pathStr(p.name)}  ${describe(p)}`);
    console.log("");
    info(`Change one with ${command("claude-multiprofile self-update <name> on|off")}.`);
    return;
  }

  const profile = findProfile(name);
  if (!profile || !profile.desktop) {
    err(`No Desktop profile called "${name}".`);
    process.exit(1);
  }

  if (!choice) {
    console.log(`  ${pathStr(profile.name)}  ${describe(profile)}`);
    return;
  }
  if (choice !== "on" && choice !== "off") {
    err(`Expected "on" or "off", got "${choice}".`);
    process.exit(1);
  }

  if (choice === "on") {
    unblockUpdates(profile.desktop.dataDir);
    replaceProfile(profile.name, { ...profile, desktop: { ...profile.desktop, selfUpdate: true } });
    ok(`${profile.name}: Claude now updates this copy itself.`);
    warn("Each of those updates relaunches it on your default account and removes its colour.");
    info(`Quit it and reopen from its launcher when that happens. ${command("claude-multiprofile doctor")} reports it.`);
  } else {
    const r = blockUpdates(profile.desktop.dataDir);
    const { selfUpdate: _dropped, ...desktop } = profile.desktop;
    replaceProfile(profile.name, { ...profile, desktop });
    if (r === "foreign") {
      warn(`${profile.name} has its own Claude configuration in that folder, so it was left alone.`);
      info("Its launcher still keeps the copy current; whether the copy also updates itself is up to that configuration.");
      return;
    }
    ok(`${profile.name}: its launcher now keeps this copy current.`);
  }
  info("Takes effect the next time the profile starts.");
}
