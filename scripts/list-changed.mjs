// Appends "files changed since <ref>" (staged + committed) to a checkpoint, as full Windows paths.
// Usage: node scripts/list-changed.mjs <git-ref> <checkpoint.md>
// (Lives in a file so shell quoting can never mangle the backslashes.)
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const [ref, file] = process.argv.slice(2);
const out = execFileSync("git", ["diff", "--cached", "--name-status", ref], { encoding: "utf8" }).trim();
const TAG = { A: "new", M: "modified", D: "deleted", R: "renamed" };
const root = resolve(".");
const lines = out.split("\n").filter(Boolean).map((l) => {
  const p = l.split("\t");
  return `- ${resolve(root, p.at(-1))} (${TAG[p[0][0]] ?? p[0]})`;
});
appendFileSync(file, lines.join("\n") + "\n");
console.log(`${lines.length} files listed`);
