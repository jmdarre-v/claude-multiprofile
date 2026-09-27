// What this machine has had APPLIED, as opposed to what is installed.
//
// `npm install -g` replaces the tool's code and nothing else. It does not
// install the launch helper, rebuild launchers, or move a profile over to a
// new way of working: those are `doctor --fix`. So a machine can run the new
// version while every profile still behaves like the old one, and nothing says
// so. v0.1.29 was exactly that: upgraded, "No problems found" from the old
// doctor, and not a single profile switched over.
//
// This records the version whose `doctor --fix` last ran, so any later version
// can tell that its changes have not reached the profiles yet.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./registry.js";
import { compareVersions } from "./util.js";

const STATE_PATH = path.join(configDir(), "state.json");

export function toolVersion() {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch {
    return null;
  }
}

export function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export function recordFixPass(version) {
  if (!version) return;
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ ...readState(), fixesAppliedFor: version }, null, 2) + "\n",
      "utf8"
    );
  } catch {
    // Losing this only means one extra reminder; never worth failing over.
  }
}

// Whether this version's fixes still need to reach the profiles. With no
// profiles there is nothing to apply. With profiles and no record at all, they
// were made by a version older than this record, so the answer is yes.
export function fixPassDue(currentVersion, profileCount, appliedFor) {
  if (!currentVersion || profileCount === 0) return false;
  if (!appliedFor) return true;
  return compareVersions(appliedFor, currentVersion) < 0;
}
