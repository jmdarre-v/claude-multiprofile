// Snapshots before `doctor --fix`, and `doctor --undo` to go back.
//
// `upgrade` runs `doctor --fix` on its own, so every repair rule reaches every
// user's machine at upgrade time, unasked. When one of those rules is wrong,
// as v0.1.31's rewrite of claudeMdExcludes was (#10), the damage is silent
// and there was no way back. This makes every fix run reversible.
//
// What a snapshot covers: the small files --fix edits. Each Code profile's
// settings.json and plugin manifests; each launcher's script, Info.plist and
// icon; the launch helper; the update-block folders it creates; state.json.
//
// What it does not: rebuilt copies of Claude.app, a re-applied colour, and a
// launcher's removed asset catalog. Those are rebuilt from the installed
// Claude rather than edited, are hundreds of megabytes or Finder metadata,
// and running --fix again regenerates them. `--undo` says so.
//
// Only what a run actually changed is kept, so a run that changed nothing
// leaves no snapshot at all.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { configDir } from "./registry.js";
import { localConfigRootFor } from "./updates.js";
import { HELPER_PATH } from "./launchhelper.js";

const SNAP_ROOT = path.join(configDir(), "snapshots");
const KEEP = 10;
const MARKER = ".claude-multiprofile";

function sha(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

// Every path a fix run may edit, for this registry.
export function fixTargets(reg) {
  const files = [HELPER_PATH, path.join(configDir(), "state.json")];
  const dirs = [];
  for (const p of (reg && reg.profiles) || []) {
    if (p.code && p.code.configDir) {
      files.push(
        path.join(p.code.configDir, "settings.json"),
        path.join(p.code.configDir, "plugins", "installed_plugins.json"),
        path.join(p.code.configDir, "plugins", "known_marketplaces.json")
      );
    }
    if (p.desktop) {
      if (p.desktop.appPath) {
        files.push(
          path.join(p.desktop.appPath, "Contents", "Info.plist"),
          path.join(p.desktop.appPath, "Contents", "Resources", "Scripts", "main.scpt"),
          path.join(p.desktop.appPath, "Contents", "Resources", "applet.icns")
        );
      }
      if (p.desktop.dataDir) dirs.push(localConfigRootFor(p.desktop.dataDir));
    }
  }
  return { files, dirs };
}

// Record the state of every target before a fix run. Cheap: these are small.
export function takeSnapshot({ files, dirs }) {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(SNAP_ROOT, id);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  const entries = [];
  files.forEach((file, i) => {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const stored = path.join("files", String(i));
      fs.copyFileSync(file, path.join(dir, stored));
      entries.push({ kind: "file", path: file, existed: true, stored, before: sha(file) });
    } else {
      entries.push({ kind: "file", path: file, existed: false });
    }
  });
  for (const d of dirs) entries.push({ kind: "dir", path: d, existed: fs.existsSync(d) });
  return { id, dir, entries };
}

// After the run: keep only what changed, and record its new state so undo can
// tell whether anything was edited since. Returns the list of changed paths;
// with nothing changed, the snapshot is deleted.
export function finishSnapshot(snap) {
  const changed = [];
  for (const e of snap.entries) {
    if (e.kind === "dir") {
      const now = fs.existsSync(e.path);
      if (now !== e.existed) changed.push({ ...e, created: now && !e.existed });
      continue;
    }
    const after = sha(e.path);
    if (e.existed ? after !== e.before : after !== null) changed.push({ ...e, after });
  }
  if (changed.length === 0) {
    fs.rmSync(snap.dir, { recursive: true, force: true });
    return [];
  }
  fs.writeFileSync(
    path.join(snap.dir, "manifest.json"),
    JSON.stringify({ id: snap.id, at: Date.now(), entries: changed }, null, 2) + "\n",
    "utf8"
  );
  // Drop stored copies of files that did not change.
  const keep = new Set(changed.filter((e) => e.stored).map((e) => e.stored));
  for (const name of fs.readdirSync(path.join(snap.dir, "files"))) {
    if (!keep.has(path.join("files", name))) fs.rmSync(path.join(snap.dir, "files", name));
  }
  prune();
  return changed.map((e) => e.path);
}

function prune() {
  const all = listSnapshots();
  for (const s of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
}

// Oldest first. Only complete snapshots (with a manifest) count.
export function listSnapshots() {
  let names;
  try {
    names = fs.readdirSync(SNAP_ROOT).sort();
  } catch {
    return [];
  }
  return names
    .map((id) => ({ id, dir: path.join(SNAP_ROOT, id) }))
    .filter((s) => fs.existsSync(path.join(s.dir, "manifest.json")));
}

// Put back the most recent fix run's changes. A file edited since that run is
// skipped rather than overwritten, unless `force`. Returns
// { id, restored: [paths], removed: [paths], skipped: [{path, why}] }, or
// null when there is nothing to undo. A fully applied undo deletes its
// snapshot, so the next --undo goes one run further back.
export function undoLatest({ force = false } = {}) {
  const all = listSnapshots();
  if (all.length === 0) return null;
  const snap = all[all.length - 1];
  const manifest = JSON.parse(fs.readFileSync(path.join(snap.dir, "manifest.json"), "utf8"));
  const result = { id: manifest.id, at: manifest.at, restored: [], removed: [], skipped: [] };

  for (const e of manifest.entries) {
    if (e.kind === "dir") {
      // Only a folder the run created, and only one the tool marked as its
      // own, is ever removed.
      if (!e.created) continue;
      if (!fs.existsSync(e.path)) continue;
      if (!fs.existsSync(path.join(e.path, MARKER))) {
        result.skipped.push({ path: e.path, why: "no longer the tool's own folder" });
        continue;
      }
      fs.rmSync(e.path, { recursive: true, force: true });
      result.removed.push(e.path);
      continue;
    }
    const now = sha(e.path);
    if (!force && now !== e.after) {
      result.skipped.push({ path: e.path, why: "changed since that run" });
      continue;
    }
    if (e.existed) {
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      fs.copyFileSync(path.join(snap.dir, e.stored), e.path);
      result.restored.push(e.path);
    } else if (now !== null) {
      fs.rmSync(e.path, { force: true });
      result.removed.push(e.path);
    }
  }

  if (result.skipped.length === 0) {
    fs.rmSync(snap.dir, { recursive: true, force: true });
  } else {
    // Keep only what is left, so retrying (with --force) does not trip over
    // the files already put back.
    const left = new Set(result.skipped.map((s) => s.path));
    manifest.entries = manifest.entries.filter((e) => left.has(e.path));
    fs.writeFileSync(path.join(snap.dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  return result;
}
