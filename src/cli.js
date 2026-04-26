// CLI entry point.
//
// Tiny argv dispatcher. We intentionally avoid pulling in commander or
// yargs because we have four commands and no flags to speak of. A
// 30-line switch is clearer than a framework.

import { add } from "./commands/add.js";
import { list } from "./commands/list.js";
import { remove } from "./commands/remove.js";
import { status } from "./commands/status.js";
import { err } from "./util.js";

const VERSION = "0.1.0";

const HELP = `claude-profiles - run multiple Claude accounts side by side on macOS

USAGE
  claude-profiles <command> [options]

COMMANDS
  add              Create a new profile (interactive wizard)
  list             List configured profiles
  status           Health-check all configured profiles
  remove [name]    Remove a profile (interactive if no name given)
  help             Show this help
  version          Show the installed version

WHAT IS A PROFILE?
  A profile is an isolated Claude install that runs alongside your
  existing one. Each profile has its own login, chats, settings, and
  MCP connectors. Common uses:

    - Personal vs. work
    - Multiple clients
    - Separate testing or evaluation accounts

  This tool sets up profiles for both Claude Desktop (the GUI app) and
  Claude Code (the terminal CLI), independently or together.

LEARN MORE
  https://github.com/jmdarre-v/claude-profiles
`;

export async function run(argv) {
  const cmd = argv[0];

  // Help-style flags before unknown-command handling so users get help
  // even if they typed a half-remembered flag.
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }

  const handlers = { add, list, status, remove };
  const handler = handlers[cmd];
  if (!handler) {
    err(`Unknown command: ${cmd}`);
    console.log("");
    console.log(HELP);
    process.exit(1);
  }

  try {
    await handler(argv.slice(1));
  } catch (e) {
    // @inquirer/prompts throws ExitPromptError when the user hits Ctrl+C.
    // We treat that as a clean exit rather than a stack trace.
    if (e && e.name === "ExitPromptError") {
      console.log("\nCancelled.");
      process.exit(130);
    }
    err(e.message || String(e));
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}
