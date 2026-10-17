// `claude-multiprofile identity [name] [own|shared]` - whether a profile's copy
// of Claude is its own application to macOS.
//
//   shared (the default)  The copy keeps Claude's identity: bundle ID
//                         com.anthropic.claudefordesktop, Anthropic's
//                         signature, the name "Claude". macOS treats it and
//                         your main Claude as one app, so a permission
//                         change's "Quit & Reopen", a quit by name or an
//                         AppleScript reaches both.
//   own                   The copy gets its own bundle ID, its own name (the
//                         launcher's) and its own permissions, re-signed with
//                         a key made on this Mac. See src/identity.js for what that
//                         costs: Anthropic's signature, and the sign-in methods
//                         that need its keychain access groups.

import { execFileSync } from "node:child_process";
import { getRegistry, findProfile, replaceProfile } from "../registry.js";
import { clonePathFor, cloneIsRunning, ensureColoredClone } from "../appclone.js";
import { compileApp, launchTargetFor, copyClaudeIcon, dataDirInUse } from "../desktop.js";
import {
  wantsOwnIdentity,
  ownIdentityFor,
  withOwnIdentity,
  readIdentity,
  identityStatus,
  checkCopyIdentity,
} from "../identity.js";
import { header, ok, warn, err, info, step, explain, command, pathStr, tildify, fileExists, isMac } from "../util.js";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function describe(p) {
  const clone = clonePathFor(p.name);
  if (!wantsOwnIdentity(p.desktop)) {
    const actual = readIdentity(clone);
    if (actual && identityStatus({ wanted: null, actual }) === "needs-shared") {
      return "shared, but the copy still carries its own identity: run `claude-multiprofile doctor --fix`";
    }
    return "shared: macOS sees it and your main Claude as one app";
  }
  const wanted = ownIdentityFor(p.name, p.desktop);
  const { state } = checkCopyIdentity(clone, wanted);
  if (state === "ok") return `own: ${wanted.bundleId}`;
  if (state === "missing") return "own, but it has no copy yet: run `claude-multiprofile doctor --fix`";
  if (state === "unsigned") return "own, but the copy's signature does not verify: run `claude-multiprofile doctor --fix`";
  if (state === "unanchored") return "own, but the copy is not signed with this Mac's key: run `claude-multiprofile doctor --fix`";
  return "own, but not on the copy yet: open the profile, or run `claude-multiprofile doctor --fix`";
}

export async function identity(args) {
  header("Desktop app identity");

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
    info(`Change one with ${command("claude-multiprofile identity <name> own|shared")}.`);
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
  if (choice !== "own" && choice !== "shared") {
    err(`Expected "own" or "shared", got "${choice}".`);
    process.exit(1);
  }
  if (!isMac()) {
    err("Desktop profiles are macOS only.");
    process.exit(1);
  }

  const wantOwn = choice === "own";
  if (wantOwn === wantsOwnIdentity(profile.desktop)) {
    ok(`${profile.name} already ${wantOwn ? "has its own identity" : "shares Claude's identity"}.`);
    console.log(`  ${pathStr(profile.name)}  ${describe(profile)}`);
    return;
  }

  // The copy is rebuilt or re-signed on disk, which cannot happen under a
  // running app, same as rename and remove.
  if (cloneIsRunning(clonePathFor(profile.name)) || dataDirInUse(profile.desktop.dataDir)) {
    err(`${profile.name} is open. Quit it (Cmd+Q) and run this again.`);
    process.exit(1);
  }
  if (!fileExists(profile.desktop.claudeAppPath)) {
    err(`Claude.app not found at ${profile.desktop.claudeAppPath}; the copy cannot be rebuilt.`);
    process.exit(1);
  }

  const { identity: _dropped, bundleId: _droppedId, ...rest } = profile.desktop;
  const desktop = wantOwn ? withOwnIdentity(profile.name, rest) : rest;
  const own = wantOwn ? ownIdentityFor(profile.name, desktop) : null;

  step(wantOwn ? `Giving ${profile.name}'s copy of Claude its own identity` : `Restoring Claude's identity on ${profile.name}'s copy`);
  if (wantOwn) {
    info(`Bundle ID: ${own.bundleId}`);
    info(`App name:  ${own.appName}`);
  }
  try {
    // Back to shared: a fresh copy is the only thing that restores
    // Anthropic's signature, hence force.
    ensureColoredClone({
      name: profile.name,
      claudeAppPath: desktop.claudeAppPath,
      color: desktop.color || null,
      identity: own,
      force: !wantOwn,
    });
    ok(wantOwn ? "Copy re-signed with its own identity." : "Copy rebuilt from Claude.app, Anthropic's signature and all.");
  } catch (e) {
    err(`Could not change the copy: ${e.message}`);
    info("The profile and its copy were left as they were. Fix the cause and run this again.");
    process.exit(1);
  }

  // The launcher tells the helper which identity to keep across updates.
  try {
    compileApp({
      name: profile.name,
      dataDir: desktop.dataDir,
      appPath: desktop.appPath,
      ...launchTargetFor(profile.name, desktop),
      codeConfigDir: profile.code ? profile.code.configDir : undefined,
      ghConfigDir: profile.code ? profile.code.ghConfigDir || undefined : undefined,
    });
    copyClaudeIcon(desktop.appPath, desktop.claudeAppPath);
    if (fileExists(LSREGISTER)) {
      try {
        execFileSync(LSREGISTER, ["-f", desktop.appPath], { stdio: "pipe" });
      } catch {
        // Non-fatal; registration catches up.
      }
    }
    ok(`Launcher rebuilt at ${pathStr(tildify(desktop.appPath))}.`);
  } catch (e) {
    err(`Could not rebuild the launcher: ${e.message}`);
    info(`Run ${command("claude-multiprofile doctor --fix")} to rebuild it.`);
  }

  replaceProfile(profile.name, { ...profile, desktop });
  ok("Registry updated.");

  console.log("");
  if (wantOwn) {
    explain(`
      ${own.appName} is now a separate application to macOS. Two effects on
      the next launch:

        - It asks for its permissions again (Screen Recording, Accessibility,
          folders): the grants belonged to Claude, and this is a new app.
        - macOS asks whether it may use the "Claude Safe Storage" Keychain
          entry, which it still shares with your main Claude (Electron names
          it after Claude's product name). Your login password allows it;
          Deny makes it ask you to sign in.

      It is signed with this Mac's own key ("claude-multiprofile local
      signing" in your login keychain, created on first use). Each time it is
      re-signed, once per Claude update, macOS asks for your login password:
      choose Allow, never Always Allow, which would let any program use it.

      From then on, a permission change, a quit, or an AppleScript addressed
      to one of them reaches that one alone, and the menu bar says which is
      which. Sign-in methods that need Claude's keychain access groups
      (passkeys, hardware keys, Microsoft Entra) are unavailable in this copy.
    `);
  } else {
    explain(`
      The copy is Claude again, as far as macOS can tell. It will ask you to
      sign in once more, and anything macOS addresses to "Claude" reaches it
      and your main Claude together.
    `);
  }
  if (wantOwn) {
    info("Signing in with Google uses the sheet inside the app, so other Claude windows can stay open.");
    info("Any sign-in that finishes in your browser still answers through claude://: quit your other Claude first for those.");
  } else {
    warn("Signing in: quit your other Claude first, or the claude:// link can land on the wrong one.");
  }
}
