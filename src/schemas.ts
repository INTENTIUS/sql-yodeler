/**
 * The JSON Schemas of `yodel <command> --json` and of `yodel mcp`'s tool
 * results. They are written beside the code, in `schemas/` at the package
 * root, and ship in the package; the docs site serves them at their `$id`.
 * test/schemas.test.ts validates each command's output against its schema.
 *
 * Within a version a schema only gains fields, and a reader ignores fields it
 * does not know. Removing a field or changing what one means is a new version:
 * a new `v<N>/` in every `$id`, and {@link SCHEMA_VERSION} moves with it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

/** Where the schemas are published; each `$id` is this plus `<name>.schema.json`. */
export const SCHEMA_BASE = `https://intentius.io/sql-yodeler/schemas/v${String(SCHEMA_VERSION)}/`;

/** `schemas/` in the package: src/ and dist/ are both one level below it. */
export const schemasDir = fileURLToPath(new URL("../schemas/", import.meta.url));

/** The schema of each command's `--json` output, by the command line that prints it. */
export const COMMAND_SCHEMAS = {
  init: "init",
  plan: "plan",
  apply: "apply",
  new: "new",
  checkpoint: "checkpoint",
  lint: "lint",
  "lint --rules": "lint-rules",
  status: "status",
  report: "report",
  drift: "drift",
  rebase: "rebase",
  repair: "repair",
  revert: "revert",
} as const;

/** Every schema file: the commands', the definitions they share, the MCP tool results, and the webhook event (#61). */
export const SCHEMA_NAMES = ["common", ...Object.values(COMMAND_SCHEMAS), "mcp", "event"] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export const schemaId = (name: SchemaName): string => `${SCHEMA_BASE}${name}.schema.json`;

/** A schema as the package ships it. */
export function readSchema(name: SchemaName): Record<string, unknown> {
  return JSON.parse(readFileSync(`${schemasDir}${name}.schema.json`, "utf8")) as Record<string, unknown>;
}
