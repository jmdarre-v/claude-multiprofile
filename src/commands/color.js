// `claude-multiprofile color [name] [colour]` - change a Desktop profile's
// Dock colour after `add`.
//
// A colour lives in four places, and all four have to change together:
//   1. the registry (desktop.color),
//   2. the custom icon on the profile's copy of Claude.app,
//   3. the custom icon on its launcher,
//   4. the hue compiled into the launcher, which the launch helper uses to
//      re-tint the copy every time it rebuilds it after a Claude update.
// Changing only the icons would look right until the next update, when the
// helper put the old colour back from (4).

import { select } from "@inquirer/prompts";
import { getRegistry, findProfile, replaceProfile } from "../registry.js";
import {
  COLORS,
  isColor,
  clonePathFor,
  cloneIsRunning,
  applyColor,
  removeCustomIcon,
} from "../appclone.js";
import { compileApp, launchTargetFor, refreshLauncher } from "../desktop.js";
import { header, ok, warn, err, info, command, pathStr, fileExists, isMac } from "../util.js";

export const COLOR_NAMES = ["none", ...Object.keys(COLORS)];

// "none" means no colour (null). Anything else unknown is undefined.
export function parseColor(input) {
  const c = String(input || "").trim().toLowerCase();
  if (c === "none") return null;
  return isColor(c) ? c : undefined;
}

// The profile with its new colour; every other field is kept as it was.
export function withColor(profile, color) {
  return { ...profile, desktop: { ...profile.desktop, color: color || null } };
}

function paint(appPath, iconSource, color) {
  if (color) applyColor(appPath, iconSource, color);
  else removeCustomIcon(appPath);
  refreshLauncher(appPath);
}

export async function color(args) {
  header("Profile colours");

  if (!isMac()) {
    err("color is a macOS-only command (Desktop profiles exist only on macOS).");
    process.exit(1);
  }

  const reg = getRegistry();
  const desktops = reg.profiles.filter((p) => p.desktop);
  const [name, choice] = args;

  if (!name) {
    if (desktops.length === 0) {
      info("No Desktop profiles configured.");
      return;
    }
    for (const p of desktops) console.log(`  ${pathStr(p.name)}  ${p.desktop.color || "none"}`);
    console.log("");
    info(`Change one with ${command("claude-multiprofile color <name> <colour>")}.`);
    return;
  }

  const profile = findProfile(name);
  if (!profile || !profile.desktop) {
    err(`No Desktop profile called "${name}".`);
    process.exit(1);
  }

  // The colour is carried by the profile's own copy of Claude.app. Profiles
  // from before v0.1.23 have none until doctor builds it.
  const clone = clonePathFor(profile.name);
  if (!fileExists(clone)) {
    err(`${profile.name} has no copy of Claude.app of its own yet, so there is nothing to colour.`);
    info(`Create it with ${command("claude-multiprofile doctor --fix")}, then run this again.`);
    process.exit(1);
  }

  let next;
  if (choice === undefined) {
    next = await select({
      message: `Dock colour for ${profile.name}:`,
      choices: [
        { name: "none (standard Claude icon)", value: null },
        ...Object.keys(COLORS).map((c) => ({ name: c, value: c })),
      ],
      default: profile.desktop.color || null,
    });
  } else {
    next = parseColor(choice);
    if (next === undefined) {
      err(`Expected one of ${COLOR_NAMES.join(", ")}, got "${choice}".`);
      process.exit(1);
    }
  }

  const updated = withColor(profile, next);
  replaceProfile(profile.name, updated);

  const appPath = profile.desktop.appPath;
  const hasLauncher = appPath && fileExists(appPath);
  try {
    // Tint from the copy's own icon: it can be a newer Claude than
    // /Applications, and it is the icon on the running window's tile.
    paint(clone, clone, next);
    if (hasLauncher) {
      // Recompile so the launch helper re-tints with the new hue (or none)
      // after the next Claude update. In place: the Dock pin is kept.
      compileApp({
        name: profile.name,
        dataDir: updated.desktop.dataDir,
        appPath,
        ...launchTargetFor(profile.name, updated.desktop),
        codeConfigDir: updated.code ? updated.code.configDir : undefined,
        ghConfigDir: updated.code ? updated.code.ghConfigDir || undefined : undefined,
      });
      paint(appPath, clone, next);
    }
  } catch (e) {
    err(`Could not apply the colour: ${e.message}`);
    info("Run the same command again to finish.");
    process.exit(1);
  }

  ok(next ? `${profile.name}: now ${next}.` : `${profile.name}: colour removed.`);
  if (!hasLauncher) {
    warn("Its launcher is missing, so only the copy changed.");
    info(`Check with ${command("claude-multiprofile doctor")}.`);
  }
  if (cloneIsRunning(clone)) {
    info(`${profile.name} is open: the new colour appears after you quit it and open it again.`);
  } else {
    info("The Dock shows it from the next launch.");
  }
}
