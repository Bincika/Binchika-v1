// Loads .env (gitignored) into process.env. Values in .env win over the shell, because the shell
// may carry credentials for other LAS projects' Cloudflare accounts. Never logs values.
import { readFileSync } from "node:fs";

export function loadEnv(path = ".env") {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return process.env; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=([^\s#]+)/);
    if (m) process.env[m[1]] = m[2];
  }
  return process.env;
}
