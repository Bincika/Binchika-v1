// Pure helpers for the portal (session 147; docs/egm/app-next/build-plan.md). No DOM, no network, so they are unit-tested.
// The section link (/portal/#s=<name>) is a convenience only: the role check here decides what opens, and the server
// decides what data any section can read.

const SECTION = /(?:^#|&)s=([a-z]{1,24})(?=&|$)/;

/** The section name asked for in the address, or null. Lower-case letters only. */
export function sectionFromHash(hash) {
  const m = SECTION.exec(String(hash ?? ""));
  return m ? m[1] : null;
}

/** The address fragment with any s=… part removed; other parts (a sign-in link's th=…) are kept. "" when nothing is left. */
export function stripSectionFromHash(hash) {
  const rest = String(hash ?? "").replace(/^#/, "").split("&").filter((p) => p && !/^s=/.test(p));
  return rest.length ? `#${rest.join("&")}` : "";
}

/** True only if that role's own list of sections contains the name. */
export function allowedSection(role, name, roleSections) {
  const list = role && Object.hasOwn(roleSections ?? {}, role) ? roleSections[role] : null;
  return Array.isArray(list) && typeof name === "string" && list.includes(name);
}

/** The ?v= tag on this page's own site.js script, from a list of script addresses. */
export function assetTag(srcs) {
  for (const src of srcs ?? []) {
    const m = /\/assets\/js\/site\.js\?v=([a-z0-9]{1,16})$/.exec(String(src ?? ""));
    if (m) return m[1];
  }
  return null;
}

/** The version suffix of the offline page's store (binchika-offline-<version>), from the browser's store names. */
export function offlineVersion(cacheNames) {
  for (const name of cacheNames ?? []) {
    const m = /^binchika-offline-([a-z0-9.]{1,12})$/.exec(String(name ?? ""));
    if (m) return m[1];
  }
  return null;
}

/** How many signing keys the app link file lists, counted as the server counts them; null if it is not that file. */
export function countAppLinkKeys(text) {
  let first;
  try { first = JSON.parse(String(text ?? ""))?.[0]; } catch { return null; }
  const prints = first?.target?.sha256_cert_fingerprints;
  if (first?.target?.namespace !== "android_app" || !Array.isArray(prints)) return null;
  return prints.filter((p) => typeof p === "string" && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(p)).length;
}
