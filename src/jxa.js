// Running JavaScript for Automation from Node.
//
// Anything here that touches macOS beyond the filesystem (Core Image for the
// icon tint, NSWorkspace for the icon, codesign and plists for a copy's
// identity) runs through `osascript -l JavaScript`, which has an Objective-C
// bridge and ships with macOS. No compiler, no Xcode Command Line Tools, no
// npm dependency. The same scripts are inlined into the launch helper
// (src/launchhelper.js), which is osascript too, so the two never disagree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function runJxa(script, args, { timeout = 60_000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-jxa-"));
  const file = path.join(tmp, "s.js");
  fs.writeFileSync(file, script, "utf8");
  try {
    return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", file, ...args], {
      encoding: "utf8",
      timeout,
    }).trim();
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best effort; the OS clears its tmpdir.
    }
  }
}
