// detect.js - find the user's default Claude Desktop and Claude Code installs.
//
// Most users already have Claude Desktop and/or Claude Code installed before
// they install this tool. Those existing installs are NOT profiles in our
// sense -- they're the user's baseline -- but we want to acknowledge them
// in `list` and `status` so users can see the full picture rather than
// thinking the tool ignores their setup.
//
// Detection is light-touch: we just check for the standard locations.
// If the user installed Claude in a non-standard place, we'll miss it,
// and that's fine -- they'll just see "no default detected" and can
// proceed normally.

import path from "node:path";
import { HOME, fileExists } from "./util.js";
import { findClaudeApp } from "./desktop.js";
import { DEFAULT_CLAUDE_CONFIG_DIR } from "./code.js";

// Where Claude Desktop stores its data by default. We treat the existence
// of this directory as the signal that Claude Desktop has been launched
// at least once. The .app being installed isn't enough; we need evidence
// it's actually been used.
export const DEFAULT_DESKTOP_DATA_DIR = path.join(
  HOME,
  "Library",
  "Application Support",
  "Claude"
);

export function detectDefaults() {
  // Returns { desktop, code } where each is either an info object or null.
  // Callers can render whichever sections are present.
  const desktopAppPath = findClaudeApp();
  const desktopDataExists = fileExists(DEFAULT_DESKTOP_DATA_DIR);
  const codeConfigExists = fileExists(DEFAULT_CLAUDE_CONFIG_DIR);

  return {
    desktop:
      desktopAppPath && desktopDataExists
        ? {
            appPath: desktopAppPath,
            dataDir: DEFAULT_DESKTOP_DATA_DIR,
          }
        : null,
    code: codeConfigExists
      ? {
          configDir: DEFAULT_CLAUDE_CONFIG_DIR,
        }
      : null,
  };
}
