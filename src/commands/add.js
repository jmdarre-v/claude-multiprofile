// `claude-profiles add` - the interactive wizard.
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

import path from "node:path";
import { input, select, confirm } from "@inquirer/prompts";
import {
  HOME,
  ok,
  warn,
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
import { findProfile, addToRegistry } from "../registry.js";
import {
  findClaudeApp,
  defaultDataDirFor,
  defaultAppPathFor,
  setupDesktop,
} from "../desktop.js";
import {
  defaultConfigDirFor,
  defaultAliasNameFor,
  DEFAULT_CLAUDE_CONFIG_DIR,
  setupCode,
} from "../code.js";
import { detectShell, rcPathForShell } from "../shell.js";

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
    message: "Profile name (e.g. work, work, client-acme):",
    validate: (v) => {
      const cleaned = sanitizeName(v);
      if (!cleaned) return "Name cannot be empty.";
      if (cleaned !== v.trim().toLowerCase()) {
        return `Use lowercase letters, numbers, and hyphens only. Suggestion: "${cleaned}"`;
      }
      if (findProfile(cleaned)) return `Profile "${cleaned}" already exists.`;
      return true;
    },
  });
  const name = sanitizeName(rawName);

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
    desktopResult = setupDesktop(desktopConfig);
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
        }
      : null,
    code: codeResult
      ? {
          configDir: codeResult.configDir,
          aliasName: codeResult.aliasName,
          shell: codeResult.shell,
          rcPath: codeResult.rcPath,
        }
      : null,
    createdAt: new Date().toISOString(),
  });

  // ---- Final guidance -------------------------------------------------

  printNextSteps({ name, desktopResult, codeResult });
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

  return { name, dataDir, appPath, claudeAppPath, applyIcon };
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

  return { name, configDir, aliasName, seedFromDefault };
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
  info(`Run ${command("claude-profiles list")} to see all configured profiles.`);
  info(`Run ${command("claude-profiles status")} for a health check.`);
}
