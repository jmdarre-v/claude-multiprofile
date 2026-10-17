// The key this Mac signs profile copies with, when they have their own app
// identity (src/identity.js).
//
// TCC and the Keychain remember an app by its signature's designated
// requirement. A requirement of the bundle ID alone is met by any code signed
// with that identifier, ad hoc included, so any program running as the user
// could `codesign -s - -i com.claude-multiprofile.<name>.claude` itself and
// inherit the profile's permission grants and Keychain access (#22 review).
// A requirement anchored to a certificate (`certificate leaf = H"..."`) is
// met only by code signed with that certificate's private key.
//
// The key is self-signed and made once per Mac, in the login keychain:
//
//   - Untrusted, on purpose. codesign signs with an identity whether or not
//     its certificate is trusted, and a requirement on the leaf hash does not
//     care about trust either, so nothing here asks to change trust settings
//     (which needs an administrator).
//   - Not extractable (-x), and trusted to no application (-T ""). That is
//     what makes it worth having: every use of the key asks for the login
//     keychain password. Any trusted application would be a way around it,
//     since any process can run it: with -T /usr/bin/codesign the key signed
//     silently from a plain shell, and with no -T at all `security import`
//     trusts itself, so `security cms -S` signed with the key silently.
//     With -T "" both wait on the keychain prompt (measured 2026-10-17).
//
// The cost is that prompt once per Claude update, when the launcher re-signs
// the copy: only the main bundle is signed with the key (TCC and the Keychain
// identify the app by it), its helpers and frameworks ad hoc, so it is one
// prompt, not one per bundle. "Always Allow" on it would add codesign to the
// key's access list and undo the point; the README says not to.
//
// Tests and CI have no key: they pass { signer: "-" } to applyOwnIdentity,
// which signs ad hoc with an identifier-only requirement. Deliberately not
// an environment variable: the launch helper runs with whatever environment
// launchd gives it, which any process of the user's can change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { HOME, info } from "./util.js";

export const SIGNING_NAME = "claude-multiprofile local signing";
const SECURITY = "/usr/bin/security";
const OPENSSL = "/usr/bin/openssl";
const LOGIN_KEYCHAIN = path.join(HOME, "Library", "Keychains", "login.keychain-db");

// ---- Shared with the JXA (src/identity.js inlines these) -----------------------
// ES5, no closures over module state: their source is pasted into JXA.

// The SHA-1 of our signing identity in `security find-identity -p
// codesigning` output, or null. Not -v: a self-signed certificate is never
// "valid", and codesign signs with it anyway.
export function parseSigningIdentity(out) {
  var lines = String(out).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]*)"/);
    if (m && m[2] === "claude-multiprofile local signing") return m[1].toUpperCase();
  }
  return null;
}

// The designated requirement a copy is signed with. "-" (ad hoc, tests only)
// has no certificate to anchor to.
export function designatedRequirement(bundleId, leaf) {
  var id = 'identifier "' + bundleId + '"';
  return leaf === "-" ? id : id + ' and certificate leaf = H"' + String(leaf).toLowerCase() + '"';
}

// Whether `codesign -d -r-` output shows a requirement anchored to this key.
export function requirementAnchored(text, leaf) {
  if (leaf === "-") return true;
  return String(text).toLowerCase().indexOf('certificate leaf = h"' + String(leaf).toLowerCase() + '"') >= 0;
}

// ---- Node side -------------------------------------------------------------------

// This Mac's key, or null.
export function findSigningIdentity() {
  try {
    return parseSigningIdentity(
      execFileSync(SECURITY, ["find-identity", "-p", "codesigning"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    );
  } catch {
    return null;
  }
}

// Make the key if this Mac has none. Returns { hash, created }.
export function ensureSigningIdentity() {
  const found = findSigningIdentity();
  if (found) return { hash: found, created: false };

  // The private key exists on disk only inside a 0700 temporary folder, for
  // the second it takes to import it, and is removed whatever happens.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-signing-"));
  try {
    const cnf = path.join(tmp, "req.cnf");
    const key = path.join(tmp, "key.pem");
    const cert = path.join(tmp, "cert.pem");
    const p12 = path.join(tmp, "id.p12");
    const pass = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(
      cnf,
      [
        "[req]",
        "distinguished_name=dn",
        "x509_extensions=ext",
        "prompt=no",
        "[dn]",
        `CN=${SIGNING_NAME}`,
        "[ext]",
        "basicConstraints=critical,CA:false",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=critical,codeSigning",
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
    // 20 years: the requirement is on this certificate's hash, so replacing
    // it means every profile re-signs and asks for its permissions again.
    execFileSync(OPENSSL, ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", key, "-out", cert, "-days", "7300", "-config", cnf], { stdio: "pipe" });
    // -name labels the key, so set-key-partition-list below can pick it out
    // of the keychain by a label no other key has.
    execFileSync(OPENSSL, ["pkcs12", "-export", "-name", SIGNING_NAME, "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${pass}`], { stdio: "pipe" });
    // -x: not extractable. -T "": no application may use it unasked, not
    // even `security` itself, which an import without -T trusts. No -f
    // pkcs12: with it, security drops the label (measured).
    execFileSync(SECURITY, ["import", p12, "-k", LOGIN_KEYCHAIN, "-P", pass, "-x", "-T", ""], { stdio: "pipe" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // A key imported by `security` is in its partition only. codesign is in
  // Apple's, and a key outside a caller's partition fails at once with
  // errSecInternalComponent instead of asking (measured: the prompt appeared
  // with nobody left waiting for it). Adding apple: lets codesign ASK; the
  // access list still lets nothing use the key without the user's say-so.
  // Changing the partition list needs the login keychain password, asked
  // for here, in the terminal, once.
  explainPartitionStep();
  const r = spawnSync(SECURITY, ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-l", SIGNING_NAME, LOGIN_KEYCHAIN], {
    stdio: ["inherit", "ignore", "inherit"],
  });
  if (r.status !== 0) {
    throw new Error(
      `the signing key was created, but codesign was not allowed to ask for it (wrong password?). Run claude-multiprofile doctor --fix to try again`
    );
  }
  const hash = findSigningIdentity();
  if (!hash) throw new Error(`created "${SIGNING_NAME}" but codesign cannot find it in the login keychain`);
  return { hash, created: true };
}

function explainPartitionStep() {
  info(`Created "${SIGNING_NAME}" in your login keychain.`);
  info("To let codesign ask for it, macOS needs your login password once (typed here, not shown).");
}

// codesign's answer when the key's prompt was declined, or could not be shown.
export function explainSigningError(message) {
  if (!/errSecInternalComponent/.test(String(message))) return message;
  return `${message}\n  macOS did not let codesign use the signing key: Deny was chosen, or the prompt could not be answered. Run it again and choose Allow (not Always Allow).`;
}

// Whether a copy on disk is signed with a requirement anchored to `leaf`.
export function copyAnchoredTo(appPath, leaf) {
  try {
    const text = execFileSync("/usr/bin/codesign", ["-d", "-r-", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return requirementAnchored(text, leaf);
  } catch {
    return false;
  }
}
