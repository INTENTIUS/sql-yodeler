import { readFileSync } from "node:fs";

/** The package version, read from package.json (one level above both src/ and dist/). */
export function version(): string {
  const url = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") {
    throw new Error(`no version in ${url.pathname}`);
  }
  return pkg.version;
}
