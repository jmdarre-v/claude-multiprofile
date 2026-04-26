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
const REGISTRY_DIR = path.join(CONFIG_HOME, "claude-profiles");
const REGISTRY_PATH = path.join(REGISTRY_DIR, "profiles.json");

const EMPTY_REGISTRY = {
  // Bumping this lets us migrate the file shape if we ever need to.
  version: 1,
  profiles: [],
};

// ---- Read --------------------------------------------------------------

export function getRegistry() {
  // Always returns a valid object. If anything's wrong with the file, we
  // start fresh rather than crashing the whole CLI. Worst case the user
  // sees an empty list and re-adds their profiles, which is recoverable.
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.profiles || !Array.isArray(parsed.profiles)) {
      return { ...EMPTY_REGISTRY };
    }
    return parsed;
  } catch {
    return { ...EMPTY_REGISTRY };
  }
}

export function findProfile(name) {
  return getRegistry().profiles.find((p) => p.name === name);
}

// ---- Write -------------------------------------------------------------

function saveRegistry(reg) {
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

export function registryLocation() {
  // Surfaced in `status` output so users know where the truth lives.
  return REGISTRY_PATH;
}
