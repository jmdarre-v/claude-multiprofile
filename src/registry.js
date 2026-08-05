// Profile registry.
//
// We need to remember what profiles the user has configured so that the
// `list`, `remove`, and `status` commands can do their jobs without scraping
// the filesystem. The registry is a tiny JSON file kept in the user's
// XDG config directory, falling back to ~/.config when XDG isn't set
// (which is typical on macOS).
//
// We intentionally keep this file *additive* and human-readable. If the user
// ever wants to inspect or hand-edit it, they can.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./util.js";

// ---- Where the registry lives ---------------------------------------------
//
// XDG_CONFIG_HOME is the standard for app config on Linux and increasingly
// adopted on macOS. We honor it if set, otherwise default to ~/.config.

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
const REGISTRY_DIR = path.join(CONFIG_HOME, "claude-multiprofile");
const REGISTRY_PATH = path.join(REGISTRY_DIR, "profiles.json");

const EMPTY_REGISTRY = {
  // Bumping this lets us migrate the file shape if we ever need to.
  version: 1,
  profiles: [],
};

// ---- Read --------------------------------------------------------------

// Distinguish the three states of the registry file. "missing" is normal
// (fresh install). "corrupt" means the file EXISTS but can't be parsed, and
// that distinction matters: treating corrupt as empty and then writing would
// permanently erase the user's profile list on the next `add` or `remove`.
function readRegistryRaw() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  } catch {
    return { state: "missing", data: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.profiles)) {
      return { state: "ok", data: parsed };
    }
  } catch {
    // fall through
  }
  return { state: "corrupt", data: null };
}

export function registryHealth() {
  // Surfaced by `doctor`, `list`, and `status` so a corrupt file is loud
  // rather than looking like "no profiles configured".
  const { state } = readRegistryRaw();
  return { state, path: REGISTRY_PATH };
}

export function getRegistry() {
  // Always returns a valid object so read-only commands keep working.
  // Corruption protection lives in saveRegistry, which refuses to write
  // over a corrupt file.
  const { state, data } = readRegistryRaw();
  return state === "ok" ? data : { ...EMPTY_REGISTRY };
}

export function findProfile(name) {
  return getRegistry().profiles.find((p) => p.name === name);
}

// ---- Write -------------------------------------------------------------

function saveRegistry(reg) {
  const { state } = readRegistryRaw();

  // Never write over a file we couldn't parse: it may still hold the user's
  // real profile list (a hand-edit gone wrong is the typical cause), and one
  // write here would make the loss permanent. Erroring out is recoverable;
  // clobbering isn't. The cli's top-level handler prints this message.
  if (state === "corrupt") {
    throw new Error(
      `The registry at ${REGISTRY_PATH} exists but is not valid JSON. ` +
        `Refusing to overwrite it. Fix the JSON by hand (or restore ` +
        `${REGISTRY_PATH}.bak if present), then re-run this command.`
    );
  }

  // Keep one backup generation of the last known-good file so a bad write
  // or bad hand-edit is a copy away from recovery.
  if (state === "ok") {
    try {
      fs.copyFileSync(REGISTRY_PATH, REGISTRY_PATH + ".bak");
    } catch {
      // Best-effort; a failed backup shouldn't block the actual save.
    }
  }

  // Make sure the parent directory exists before writing. fs.mkdirSync with
  // recursive:true is idempotent, so re-running is fine.
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

export function addToRegistry(profile) {
  const reg = getRegistry();
  // Defensive: replace if a same-named profile somehow exists. The CLI
  // already validates uniqueness during `add`, but better to be safe.
  reg.profiles = reg.profiles.filter((p) => p.name !== profile.name);
  reg.profiles.push(profile);
  saveRegistry(reg);
}

export function removeFromRegistry(name) {
  const reg = getRegistry();
  const before = reg.profiles.length;
  reg.profiles = reg.profiles.filter((p) => p.name !== name);
  saveRegistry(reg);
  return reg.profiles.length < before;
}

export function replaceProfile(oldName, newProfile) {
  // Used by `rename`: swap the entry for `oldName` with a fully-rebuilt
  // profile object (which may carry a different name). Order is preserved so
  // `list` output doesn't jump around.
  const reg = getRegistry();
  const idx = reg.profiles.findIndex((p) => p.name === oldName);
  if (idx === -1) {
    reg.profiles.push(newProfile);
  } else {
    reg.profiles[idx] = newProfile;
  }
  saveRegistry(reg);
}

export function registryLocation() {
  // Surfaced in `status` output so users know where the truth lives.
  return REGISTRY_PATH;
}
