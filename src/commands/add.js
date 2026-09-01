// `claude-multiprofile add` - the interactive wizard.
//
// This is the only command most users will ever run. It walks through
// every choice involved in setting up a new profile, explaining what's
// happening at each step. Power users can skip ahead by accepting
// defaults; cautious users can read along.
//
// The wizard is organized in three phases:
//
//   1. What kind of profile? (Desktop, Code, or both)
//   2. Profile name + per-target configuration questions
//   3. Confirmation, execution, and printed next steps

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { input, select, confirm } from "@inquirer/prompts";
import {
  HOME,
  ok,
  warn,
  err,
  info,
  step,
  header,
  explain,
  command,
  pathStr,
  tildify,
  expandHome,
  fileExists,
  isMac,
  sanitizeName,
  titleCase,
} from "../util.js";
import { findProfile, addToRegistry, getRegistry, replaceProfile } from "../registry.js";
import { resyncDenyRules } from "../permissions.js";
import {
  findClaudeApp,
  defaultDataDirFor,
  defaultAppPathFor,
  setupDesktop,
  compileApp,
  copyClaudeIcon,
} from "../desktop.js";

import {
  defaultConfigDirFor,
  defaultAliasNameFor,
  DEFAULT_CLAUDE_CONFIG_DIR,
  setupCode,
  hasGhCli,
  ghTokenOverride,
  defaultGhConfigDirFor,
  addAlias,
} from "../code.js";
import { detectShell, rcPathForShell } from "../shell.js";
import { COLORS } from "../appclone.js";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// Directory basenames under $HOME that belong to OTHER tools in the Claude
// ecosystem (or to Claude itself). Naming a profile `mem` would default its
// config dir to ~/.claude-mem, which is claude-mem's data directory, and a
// later `remove` would then offer to delete it. We refuse these names outright
// rather than asking, because there is never a good reason to claim them.
//
// Keyed by profile name; the value is what it would collide with.
const RESERVED_NAMES = {
  mem: "claude-mem (~/.claude-mem)",
  profiles: "claude-profiles (~/.claude-profiles)",
  multiprofile: "this tool's own config (~/.claude-multiprofile)",
  code: "reserved (~/.claude-code)",
  desktop: "reserved (~/.claude-desktop)",
};

// A complete profile can still gain something: its own GitHub CLI login, if
// gh is installed and the profile has a Code half that is not isolated yet.
export function canEnableGh(profile, ghAvailable = hasGhCli()) {
  return Boolean(ghAvailable && profile.code && !profile.code.ghConfigDir);
}

// Which of the selected targets this profile does not have yet. Empty means
// there is nothing to link and the name really is taken.
export function missingTargets(profile, { wantsDesktop, wantsCode }) {
  const missing = [];
  if (wantsDesktop && !profile.desktop) missing.push("desktop");
  if (wantsCode && !profile.code) missing.push("code");
  return missing;
}

// A directory we're about to claim is only safe if it doesn't already exist,
// OR it exists and is already registered to this tool. Anything else is
// somebody else's data and we must not silently adopt it.
function isUnmanagedExistingDir(dirPath) {
  if (!fileExists(dirPath)) return false;
  const reg = getRegistry();
  for (const p of reg.profiles) {
    if (p.code && p.code.configDir === dirPath) return false;
    if (p.desktop && p.desktop.dataDir === dirPath) return false;
  }
  return true;
}

export async function add() {
  header("Add a Claude profile");

  explain(`
    A "profile" is an isolated Claude install that runs alongside your existing
    one. Each profile has its own login, chats, settings, and MCP connectors.
    You typically want one for personal use and one for work, but you can
    create as many as you need (client A, client B, etc.).

    This tool does NOT touch your existing default Claude. Your current login
    and chats stay exactly as they are. We only set up the new profile next
    to it.
  `);

  // ---- Phase 1: pick targets ------------------------------------------

  const targets = await select({
    message: "What do you want to set up for this profile?",
    choices: [
      {
        name: "Both Claude Desktop and Claude Code (recommended)",
        value: "both",
        description: "Sets up the GUI app and the terminal CLI together.",
      },
      {
        name: "Claude Desktop only (the GUI chat app)",
        value: "desktop",
        description: "For when you only use the macOS app.",
      },
      {
        name: "Claude Code only (the terminal CLI)",
        value: "code",
        description: "For when you only use Claude in the terminal.",
      },
    ],
    default: "both",
  });

  const wantsDesktop = targets === "desktop" || targets === "both";
  const wantsCode = targets === "code" || targets === "both";

  // Hard-stop if the user wants Desktop on a non-Mac. The --user-data-dir
  // recipe is macOS-specific.
  if (wantsDesktop && !isMac()) {
    warn(
      `Claude Desktop multi-profile setup only works on macOS. Detected: ${process.platform}.`
    );
    warn("Continuing with Claude Code setup only.");
  }
  const desktopApplicable = wantsDesktop && isMac();

  // ---- Phase 2: profile name -------------------------------------------

  const rawName = await input({
    message: "Profile name (e.g. work, personal, client-acme):",
    validate: (v) => {
      const cleaned = sanitizeName(v);
      if (!cleaned) return "Name cannot be empty.";
      if (cleaned !== v.trim().toLowerCase()) {
        return `Use lowercase letters, numbers, and hyphens only. Suggestion: "${cleaned}"`;
      }
      if (RESERVED_NAMES[cleaned]) {
        return `"${cleaned}" is reserved. It would collide with ${RESERVED_NAMES[cleaned]}. Pick another name.`;
      }
      // An existing name is only an error when there is nothing left to add.
      // A Desktop-only profile that needs Claude Code (or the reverse) is a
      // half-built profile, and completing it is the whole point of linking.
      const existing = findProfile(cleaned);
      if (
        existing &&
        !missingTargets(existing, { wantsDesktop, wantsCode }).length &&
        !canEnableGh(existing)
      ) {
        return `Profile "${cleaned}" already exists with everything you selected.`;
      }
      return true;
    },
  });
  const name = sanitizeName(rawName);

  // ---- Phase 2.5: completing an existing profile -------------------------
  //
  // The name matched a profile that is missing one half. Offer to link the
  // missing half onto it rather than making the user invent a second name,
  // which is what leaves people with a Desktop profile whose Claude Code
  // sessions quietly run against the shared ~/.claude.

  const existing = findProfile(name);
  if (existing) {
    const missing = missingTargets(existing, { wantsDesktop, wantsCode });
    if (missing.length === 0) return enableGhForProfile(existing);
    return linkExisting(existing, missing);
  }

  // ---- Phase 2a: Desktop questions -------------------------------------

  let desktopConfig = null;
  if (desktopApplicable) {
    desktopConfig = await askDesktopQuestions(name);
    if (!desktopConfig) {
      // The user backed out (e.g. Claude.app not found and they chose not
      // to provide a path). Skip Desktop, keep going if they also picked
      // Code; otherwise abort.
      if (!wantsCode) {
        warn("Setup cancelled.");
        return;
      }
    }
  }

  // ---- Phase 2b: Code questions ----------------------------------------

  let codeConfig = null;
  if (wantsCode) {
    codeConfig = await askCodeQuestions(name);
    // The user declined to claim an existing folder. If Code was the only
    // target there's nothing left to do; otherwise carry on with Desktop.
    if (!codeConfig && !desktopConfig) {
      return;
    }
  }

  // ---- Phase 3: confirm and execute ------------------------------------

  step("Review");
  printPlan({ name, desktopConfig, codeConfig });

  const proceed = await confirm({
    message: "Apply this configuration?",
    default: true,
  });
  if (!proceed) {
    warn("Cancelled. Nothing was changed.");
    return;
  }

  let desktopResult = null;
  let codeResult = null;

  if (desktopConfig) {
    // Hand the Code config dir to the Desktop launcher so it can export
    // CLAUDE_CONFIG_DIR. Without this, Claude Code sessions started from
    // inside Claude Desktop fall back to ~/.claude in every profile, and
    // CLAUDE.md / settings.json / per-project memory merge across profiles
    // even though Desktop itself is cleanly isolated.
    // Undefined when the profile has no Code target, in which case the launcher
    // omits --env and behaves exactly as it did before.
    desktopResult = setupDesktop({
      ...desktopConfig,
      codeConfigDir: codeConfig?.configDir,
    });
  }
  if (codeConfig) {
    codeResult = setupCode(codeConfig);
  }

  // ---- Persist to registry -------------------------------------------

  addToRegistry({
    name,
    type: targets,
    desktop: desktopResult
      ? {
          dataDir: desktopResult.dataDir,
          appPath: desktopResult.appPath,
          claudeAppPath: desktopResult.claudeAppPath,
          color: desktopResult.color || null,
        }
      : null,
    code: codeResult
      ? {
          configDir: codeResult.configDir,
          aliasName: codeResult.aliasName,
          shell: codeResult.shell,
          rcPath: codeResult.rcPath,
          ghConfigDir: codeResult.ghConfigDir || null,
        }
      : null,
    createdAt: new Date().toISOString(),
  });

  // ---- Cross-profile read protection (issue #4) ------------------------
  //
  // Now that the profile set has changed, rewrite every Code profile's deny
  // rules so no profile can read a sibling's config/data directories.

  resyncDenyRules(getRegistry(), { verbose: true });

  // ---- Final guidance -------------------------------------------------

  printNextSteps({ name, desktopResult, codeResult });
}

// ===========================================================================
// Turning on gh isolation for a profile that is otherwise complete
// ===========================================================================
//
// Profiles created before 0.1.16, or ones that declined gh isolation at
// creation, have both halves but no GitHub CLI separation. There was no way to
// enable it afterwards short of hand-editing the alias, so `add` now routes a
// complete profile here instead of refusing the name.
//
// Both surfaces have to be updated or the isolation is half-applied: the shell
// alias covers `claude-<name>` in a terminal, and the Desktop launcher covers
// Claude Code opened from inside the Desktop app.

async function enableGhForProfile(profile) {
  step(`Profile "${profile.name}" is already set up`);
  info("It has both Claude Desktop and Claude Code." );
  console.log("");

  explain(`
    One thing it does not have yet is its own GitHub CLI login. Right now any
    "gh" command Claude runs in this profile uses your machine's default
    GitHub account.

    Turning this on points GH_CONFIG_DIR at a folder inside the profile, so
    the profile can be signed in as a different GitHub account. You sign in
    once afterwards with "gh auth login".
  `);

  const proceed = await confirm({
    message: `Give "${profile.name}" its own GitHub CLI login?`,
    default: true,
  });
  if (!proceed) {
    warn("Nothing was changed.");
    return;
  }

  const override = ghTokenOverride();
  if (override) {
    console.log("");
    warn(`${override} is set in your environment.`);
    info("gh prefers that token over any config directory, so this profile");
    info("would still act as that token's account. Unset it in your shell");
    info("config for per-profile gh logins to take effect.");
    console.log("");
  }

  const ghConfigDir = defaultGhConfigDirFor(profile.code.configDir);
  fs.mkdirSync(ghConfigDir, { recursive: true });
  ok(`Created ${pathStr(tildify(ghConfigDir))}`);

  // Surface 1: the shell alias.
  const { rcPath } = addAlias({
    aliasName: profile.code.aliasName,
    configDir: profile.code.configDir,
    ghConfigDir,
  });
  ok(`Alias "${profile.code.aliasName}" updated in ${pathStr(tildify(rcPath))}.`);

  const next = {
    ...profile,
    code: { ...profile.code, ghConfigDir, rcPath },
  };

  // Surface 2: the Desktop launcher, whose env is compiled in at build time.
  if (profile.desktop && profile.desktop.appPath) {
    if (!fileExists(profile.desktop.claudeAppPath)) {
      warn(`Claude.app not found at ${profile.desktop.claudeAppPath}; launcher left as is.`);
      info(`Claude Code opened from the Desktop app will keep using your default gh account.`);
    } else {
      try {
        compileApp({
          name: profile.name,
          dataDir: profile.desktop.dataDir,
          appPath: profile.desktop.appPath,
          claudeAppPath: profile.desktop.claudeAppPath,
          codeConfigDir: profile.code.configDir,
          ghConfigDir,
        });
        copyClaudeIcon(profile.desktop.appPath, profile.desktop.claudeAppPath);
        try {
          execFileSync(LSREGISTER, ["-f", profile.desktop.appPath], { stdio: "pipe" });
        } catch {
          // Non-fatal.
        }
        ok("Desktop launcher rebuilt so it exports the same gh config.");
      } catch (e) {
        err(`Could not rebuild the launcher: ${e.message}`);
        info(`Run ${command("claude-multiprofile doctor --fix")} to retry.`);
      }
    }
  }

  replaceProfile(profile.name, next);

  console.log("");
  ok(`"${profile.name}" now has its own GitHub CLI config.`);
  console.log("");
  info("Sign in for this profile (run this once, from anywhere):");
  console.log("  " + command(`GH_CONFIG_DIR="${tildify(ghConfigDir)}" gh auth login`));
  console.log("");
  info("Then reload your shell so the updated alias takes effect:");
  console.log("  " + command(`source ${tildify(rcPath)}`));
  explain(`
    After that, every "gh" command Claude runs inside this profile uses that
    account. If the Desktop app is open, quit and reopen it to pick up the
    rebuilt launcher.
  `);
}

// ===========================================================================
// Linking a missing half onto an existing profile
// ===========================================================================
//
// The case this exists for: you set up a Desktop profile months ago, and only
// later realise that Claude Code launched from inside it is using the shared
// ~/.claude. Before this, `add` refused the name and there was no way to
// complete the profile short of removing and rebuilding it.
//
// Linking Code onto a Desktop profile is NOT just creating a config dir. The
// launcher has to be rebuilt too, because the CLAUDE_CONFIG_DIR it exports is
// baked into the compiled AppleScript at creation time. Skip that and the
// link looks successful while Desktop keeps spawning the shared CLI, which is
// exactly the invisible failure we are trying to remove.

async function linkExisting(profile, missing) {
  step(`Completing the existing profile "${profile.name}"`);

  const has = [profile.desktop && "Claude Desktop", profile.code && "Claude Code"]
    .filter(Boolean)
    .join(" and ");
  const adding = missing.map((m) => (m === "desktop" ? "Claude Desktop" : "Claude Code")).join(" and ");

  info(`It currently has: ${has}`);
  info(`Missing: ${adding}`);
  console.log("");

  if (missing.includes("code") && profile.desktop) {
    explain(`
      Right now, Claude Code started from inside this Desktop profile falls
      back to your shared ~/.claude, so its CLAUDE.md, settings, and project
      memory are the same ones your other profiles use.

      Linking gives it its own config folder and rebuilds the launcher so the
      Desktop app points Claude Code at it. Your Desktop chats, login, and
      settings are untouched.
    `);
  }

  const proceed = await confirm({
    message: `Add ${adding} to "${profile.name}"?`,
    default: true,
  });
  if (!proceed) {
    warn("Cancelled. Nothing was changed.");
    return;
  }

  // ---- Gather config for the missing half only ---------------------------

  let desktopConfig = null;
  let codeConfig = null;
  if (missing.includes("desktop")) {
    if (!isMac()) {
      warn(`Claude Desktop setup requires macOS. Detected: ${process.platform}.`);
      return;
    }
    desktopConfig = await askDesktopQuestions(profile.name);
    if (!desktopConfig) {
      warn("Cancelled. Nothing was changed.");
      return;
    }
  }
  if (missing.includes("code")) {
    codeConfig = await askCodeQuestions(profile.name);
    if (!codeConfig) return; // user declined to claim an existing folder
  }

  // ---- Apply --------------------------------------------------------------

  const next = { ...profile };

  if (codeConfig) {
    const codeResult = setupCode(codeConfig);
    next.code = {
      configDir: codeResult.configDir,
      aliasName: codeResult.aliasName,
      shell: codeResult.shell,
      rcPath: codeResult.rcPath,
      ghConfigDir: codeResult.ghConfigDir || null,
    };
  }

  if (desktopConfig) {
    // New launcher: pass the config dir straight in, whether it was already
    // there or we just created it.
    const desktopResult = setupDesktop({
      ...desktopConfig,
      codeConfigDir: next.code ? next.code.configDir : undefined,
    });
    next.desktop = {
      dataDir: desktopResult.dataDir,
      appPath: desktopResult.appPath,
      claudeAppPath: desktopResult.claudeAppPath,
      color: desktopResult.color || null,
    };
  } else if (next.code && profile.desktop) {
    // Existing launcher, newly linked Code target: the launcher must be
    // rebuilt so it exports CLAUDE_CONFIG_DIR. Without this the link is
    // cosmetic.
    step("Rebuilding the Desktop launcher");
    if (!fileExists(profile.desktop.claudeAppPath)) {
      err(`Claude.app not found at ${profile.desktop.claudeAppPath}; cannot rebuild the launcher.`);
      info(`Fix that, then run ${command("claude-multiprofile doctor --fix")}.`);
    } else {
      try {
        compileApp({
          name: profile.name,
          dataDir: profile.desktop.dataDir,
          appPath: profile.desktop.appPath,
          claudeAppPath: profile.desktop.claudeAppPath,
          codeConfigDir: next.code.configDir,
        });
        copyClaudeIcon(profile.desktop.appPath, profile.desktop.claudeAppPath);
        try {
          execFileSync(LSREGISTER, ["-f", profile.desktop.appPath], { stdio: "pipe" });
        } catch {
          // Non-fatal; the bundle works, registration catches up.
        }
        ok("Launcher rebuilt. Claude Code opened from this Desktop profile now uses its own config.");
      } catch (e) {
        err(`Could not rebuild the launcher: ${e.message}`);
        info(`Run ${command("claude-multiprofile doctor --fix")} to retry.`);
      }
    }
  }

  next.type = next.desktop && next.code ? "both" : next.desktop ? "desktop" : "code";
  replaceProfile(profile.name, next);
  resyncDenyRules(getRegistry(), { verbose: true });

  console.log("");
  ok(`Profile "${profile.name}" now has Claude Desktop and Claude Code linked.`);

  if (codeConfig) {
    console.log("");
    info("Activate the shell alias in this terminal:");
    console.log("  " + command(`source ${tildify(next.code.rcPath)}`));
    console.log("");
    info("Then launch the profile's Claude Code with:");
    console.log("  " + command(next.code.aliasName));
    explain(`
      On first run, use /login inside the REPL to sign in for this profile.

      If the Desktop app is open, quit and reopen it so it picks up the
      rebuilt launcher.
    `);
  }
}

// ===========================================================================
// Desktop wizard questions
// ===========================================================================

async function askDesktopQuestions(name) {
  step("Claude Desktop configuration");

  explain(`
    Claude Desktop stores everything (login, chats, settings, MCP servers)
    in a single folder. By giving the new profile its own folder, we get
    a fully isolated second account.

    We will also create a real macOS .app launcher for this profile so you
    can put it on your Dock and launch it like any other app.
  `);

  // Find Claude.app first so we can fail fast if it's missing.
  let claudeAppPath = findClaudeApp();
  if (!claudeAppPath) {
    warn("Claude.app was not found at any of the standard locations.");
    info(
      "If you have Claude Desktop installed somewhere unusual, you can point us at it now."
    );
    const customPath = await input({
      message: "Path to Claude.app (or leave blank to skip Desktop setup):",
      validate: (v) => {
        if (!v) return true;
        const p = expandHome(v);
        if (!fileExists(p)) return `Not found: ${p}`;
        if (!p.endsWith(".app")) return "Path must end in .app";
        return true;
      },
    });
    if (!customPath) return null;
    claudeAppPath = expandHome(customPath);
  } else {
    info(`Found Claude Desktop at ${pathStr(claudeAppPath)}.`);
  }

  // Data folder
  explain(`
    Where should the new profile's data live? The default puts it next to
    your current Claude data, both inside ~/Library/Application Support/.
    The folder will be created if it doesn't exist; nothing inside your
    existing ~/Library/Application Support/Claude folder will be touched.
  `);
  const defaultData = defaultDataDirFor(name);
  const dataDirRaw = await input({
    message: "Data folder for this profile:",
    default: defaultData,
    validate: (v) => {
      const p = expandHome(v.trim());
      if (!p) return "Path cannot be empty.";
      if (p === path.join(HOME, "Library", "Application Support", "Claude")) {
        return "That's the default Claude folder. Pick a different path so the new profile stays isolated.";
      }
      return true;
    },
  });
  const dataDir = expandHome(dataDirRaw.trim());

  // Same protection as the Code config dir: never silently adopt a folder
  // that already exists and belongs to something else.
  if (isUnmanagedExistingDir(dataDir)) {
    console.log("");
    warn(`${tildify(dataDir)} already exists and isn't managed by this tool.`);
    explain(`
      This tool will treat that folder's contents as this profile's Desktop
      data, including when "claude-multiprofile remove" later offers to
      delete it. If it belongs to something else, choose a different path.
    `);
    const claimIt = await confirm({
      message: `Use ${tildify(dataDir)} anyway?`,
      default: false,
    });
    if (!claimIt) {
      warn("Cancelled. Re-run and choose a different data folder.");
      return null;
    }
  }

  // App launcher path
  explain(`
    We'll generate a small .app bundle that, when double-clicked, launches
    Claude with the right --user-data-dir flag for this profile. You can
    drag the .app to your Dock for one-click access.

    The default location is ~/Applications because it doesn't require
    administrator permission to write to. You can also use /Applications,
    but that might prompt for your password.
  `);
  const defaultApp = defaultAppPathFor(name);
  const appPathRaw = await input({
    message: "Where to save the launcher .app:",
    default: defaultApp,
    validate: (v) => {
      const p = expandHome(v.trim());
      if (!p.endsWith(".app")) return "Path must end in .app";
      return true;
    },
  });
  const appPath = expandHome(appPathRaw.trim());

  const applyIcon = await confirm({
    message: "Copy the Claude icon onto the launcher? (recommended)",
    default: true,
  });

  // Per-profile Dock colour (issue #2). Opt-in: choosing none keeps exactly
  // today's behaviour, launching the shared /Applications/Claude.app.
  explain(`
    Claude Desktop's Dock tile always shows the standard Claude icon, even
    when you customise the launcher, because the running window belongs to
    Claude itself rather than to the launcher.

    Giving this profile a colour works around that: it launches a private
    copy of Claude.app tinted that colour, so the running window's Dock tile
    is finally distinguishable. The copy is an APFS clone, which costs a few
    megabytes rather than a few hundred, and Anthropic's signature stays
    intact so your login keeps working.
  `);
  const color = await select({
    message: "Dock colour for this profile:",
    choices: [
      { name: "none (standard Claude icon)", value: null },
      ...Object.keys(COLORS).map((c) => ({ name: c, value: c })),
    ],
    default: null,
  });

  return { name, dataDir, appPath, claudeAppPath, applyIcon, color };
}

// ===========================================================================
// Claude Code wizard questions
// ===========================================================================

async function askCodeQuestions(name) {
  step("Claude Code configuration");

  explain(`
    Claude Code (the terminal CLI) keeps everything under ~/.claude by
    default. We'll give this profile its own config directory and add a
    shell alias so you can launch it with a single command.
  `);

  const defaultDir = defaultConfigDirFor(name);
  const configDirRaw = await input({
    message: "Config folder for this profile:",
    default: defaultDir,
    validate: (v) => {
      const p = expandHome(v.trim());
      if (!p) return "Path cannot be empty.";
      if (p === DEFAULT_CLAUDE_CONFIG_DIR) {
        return "That's the default Claude Code folder. Pick a different path.";
      }
      return true;
    },
  });
  const configDir = expandHome(configDirRaw.trim());

  // Claiming a directory that already exists and isn't ours is how another
  // tool's data (claude-mem, a hand-rolled setup) gets adopted into a profile
  // and later offered up for deletion by `remove`. Make the user say yes.
  if (isUnmanagedExistingDir(configDir)) {
    console.log("");
    warn(`${tildify(configDir)} already exists and isn't managed by this tool.`);
    explain(`
      Pointing a profile at an existing folder means this tool will treat its
      contents as that profile's data, including when you later run
      "claude-multiprofile remove", which offers to delete the folder.

      If this folder belongs to another tool (claude-mem, claude-profiles) or
      to a setup you made by hand, pick a different path instead.
    `);
    const claimIt = await confirm({
      message: `Use ${tildify(configDir)} anyway?`,
      default: false,
    });
    if (!claimIt) {
      warn("Cancelled. Re-run and choose a different config folder.");
      return null;
    }
  }

  const defaultAlias = defaultAliasNameFor(name);
  const aliasName = await input({
    message: "Shell alias to launch this profile:",
    default: defaultAlias,
    validate: (v) => {
      if (!v.trim()) return "Alias cannot be empty.";
      if (v === "claude")
        return "Don't shadow the bare `claude` command; pick a different alias.";
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(v))
        return "Alias must start with a letter and contain only letters, digits, hyphens, or underscores.";
      return true;
    },
  });

  // Seeding decision: only offered if a default ~/.claude exists.
  let seedFromDefault = false;
  if (fileExists(DEFAULT_CLAUDE_CONFIG_DIR)) {
    explain(`
      You already have a ~/.claude config from your existing Claude Code
      install. We can copy its contents into the new profile's folder so
      that any skills, plugins, MCP servers, or slash commands you've set
      up come along for the ride.

      Authentication does NOT carry over. Claude Code stores its login in
      macOS Keychain under a key derived from CLAUDE_CONFIG_DIR, which is
      different for the new profile. You'll sign in fresh on first launch.
    `);
    seedFromDefault = await confirm({
      message: "Copy your existing ~/.claude into the new profile? (recommended)",
      default: true,
    });
  }

  // GitHub CLI isolation: opt-in, and only worth offering if gh is installed.
  // Plenty of people deliberately want one GitHub identity across every Claude
  // profile, so this is off by default.
  let isolateGh = false;
  if (hasGhCli()) {
    explain(`
      The GitHub CLI (gh) reads its logged-in account from a config folder,
      and it honors GH_CONFIG_DIR the same way Claude Code honors
      CLAUDE_CONFIG_DIR. We can give this profile its own, so any "gh"
      command Claude runs here acts as a separate GitHub account.

      Useful when a profile maps to a client or employer with its own GitHub
      org. Leave it off to keep using your current single gh login
      everywhere, which is what most setups want.
    `);
    isolateGh = await confirm({
      message: "Give this profile its own GitHub CLI login?",
      default: false,
    });
    if (isolateGh) {
      const override = ghTokenOverride();
      if (override) {
        warn(`${override} is set in your environment.`);
        info("That overrides per-profile gh config, so every profile would use that token.");
        info("Unset it in your shell config for profile-specific gh logins to take effect.");
      }
    }
  }

  return { name, configDir, aliasName, seedFromDefault, isolateGh };
}

// ===========================================================================
// Plan summary + next-steps printer
// ===========================================================================

function printPlan({ name, desktopConfig, codeConfig }) {
  console.log(`  Profile name: ${pathStr(name)}\n`);
  if (desktopConfig) {
    console.log("  Claude Desktop:");
    console.log(`    Data folder: ${pathStr(tildify(desktopConfig.dataDir))}`);
    console.log(`    Launcher app: ${pathStr(tildify(desktopConfig.appPath))}`);
    console.log(
      `    Apply Claude icon: ${desktopConfig.applyIcon ? "yes" : "no"}\n`
    );
  }
  if (codeConfig) {
    console.log("  Claude Code:");
    console.log(`    Config folder: ${pathStr(tildify(codeConfig.configDir))}`);
    console.log(`    Shell alias: ${pathStr(codeConfig.aliasName)}`);
    console.log(
      `    Seed from existing ~/.claude: ${codeConfig.seedFromDefault ? "yes" : "no"}\n`
    );
  }
}

function printNextSteps({ name, desktopResult, codeResult }) {
  console.log("");
  ok(`Profile "${name}" is ready.`);
  console.log("");

  if (desktopResult) {
    step("Next: sign in to Claude Desktop");
    explain(`
      The first time you launch the new Desktop profile, you'll need to sign
      in with the account that should belong to it. Do this carefully:

        1. Quit any other Claude window first (Cmd+Q from the menu bar).
           Claude's sign-in flow uses a claude:// deep link that gets routed
           to whatever Claude instance is running. If two are open at once,
           the token can land on the wrong one.

        2. Double-click the new launcher (or run the open command below).

        3. Sign in with the account for this profile.

        4. Quit the new profile (Cmd+Q) once you've confirmed it's logged in.

      From now on, both profiles can run at the same time. Open your default
      Claude from the Dock for the original account, and your new launcher
      for this one.
    `);
    info("First-launch command (only needed if you didn't drag the .app yet):");
    console.log(
      "  " + command(`open "${desktopResult.appPath}"`)
    );
    console.log("");
    explain(`
      To keep it in your Dock, drag the launcher itself from ~/Applications.

      Do NOT drag the Claude window's tile down while it is running. That
      tile belongs to Claude itself rather than to this profile, so pinning
      it would launch the shared Claude next time, not this account. It is
      the usual reason a profile icon "stops working" and has to be re-pinned.
    `);
    console.log("");
  }

  if (codeResult) {
    step("Next: activate the shell alias");
    explain(`
      The alias was added to your shell config but won't be available in
      already-open terminal windows. Either open a new terminal tab, or
      reload your config in this one.
    `);
    info("Reload your shell config:");
    console.log("  " + command(`source ${tildify(codeResult.rcPath)}`));
    console.log("");
    info(`Then launch your new profile with:`);
    console.log("  " + command(codeResult.aliasName));
    console.log("");
    explain(`
      On the first run, you'll see Claude Code's normal login flow. Run
      /login inside the REPL and sign in with the account for this profile.
      The session is saved to the new config folder, so future launches
      keep you signed in.
    `);
  }

  step("Done.");
  info(`Run ${command("claude-multiprofile list")} to see all configured profiles.`);
  info(`Run ${command("claude-multiprofile status")} for a health check.`);
}
