/**
 * A yodel project as a member of a chant workspace (#2): chant reads its
 * tables and columns as outputs (INTENTIUS/chant#3931), offline, from the
 * declarations in src/, and a dbt member's sources link to them
 * (INTENTIUS/chant#3932). Each starter template is copied in as the member
 * `db`, with two backfill modules of the kind `yodel new --backfill`
 * writes, beside an app that links to a column by hand and a dbt project
 * whose sources.yml reads the same table. No server: `chant workspace
 * check` never runs a member's code.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backfillTemplate } from "../src/steps/backfill.js";
import { repoRoot } from "./helpers/run.js";

type Dialect = "clickhouse" | "postgres";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const LEXICON = "@intentius/chant-lexicon-sql";
const lexiconVersion = (JSON.parse(readFileSync(join(repoRoot, "node_modules", LEXICON, "package.json"), "utf8")) as { version: string }).version;

/** Where each template's events table is, as an output names it: its default database or schema. */
const SCHEMA: Record<Dialect, string> = { clickhouse: "app", postgres: "app" };

/** Copies `templates/<dialect>` to `dir`, each {{chant:<param>}} given its default. */
function template(dialect: Dialect, dir: string): void {
  const from = join(repoRoot, "templates", dialect);
  cpSync(from, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(from, "chant.template.json"), "utf8")) as { parameters: Record<string, { default: string }>; files: string[] };
  for (const f of manifest.files) {
    const path = join(dir, f);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\{\{chant:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name: string) => manifest.parameters[name]?.default ?? name));
  }
  rmSync(join(dir, "chant.template.json"));
}

/** Adds a column `note` to the template's events table, with `trailer` after it (a `-- previously:` hint). */
function addNote(dialect: Dialect, dir: string, column = "note", trailer = ""): void {
  const path = join(dir, "src", "schema.ts");
  const type = dialect === "clickhouse" ? "String" : "text";
  const text = readFileSync(path, "utf8");
  const next = text.replace(/(CREATE TABLE \$\{\w+\}\.events \(\n)/, `$1    ${column} ${type},${trailer}\n`);
  if (next === text) throw new Error(`no events table in ${path}`);
  writeFileSync(path, next);
}

/** Puts each Op back under the export `op`, as a project made before #2 has them. */
function asBefore(db: string): void {
  const files = [...readdirSync(join(db, "ops")).map((f) => join(db, "ops", f)), ...readdirSync(join(db, "migrations")).filter((d) => d.startsWith("2026")).map((d) => join(db, "migrations", d, "backfill.ts"))];
  for (const f of files) writeFileSync(f, readFileSync(f, "utf8").replace(/export const \{ op: \w+ \} =/, "export const { op } =").replace(/export const \w+ = Op\(/, "export const op = Op("));
}

function workspace(dialect: Dialect, note: { column?: string; trailer?: string } | false, before = false): string {
  const root = mkdtempSync(join(tmpdir(), `yodel-workspace-${dialect}-`));
  temps.push(root);
  const db = join(root, "db");
  template(dialect, db);
  if (note) addNote(dialect, db, note.column, note.trailer);
  // Two backfills as yodel new --backfill writes them: each exports its Op under a name of its own.
  for (const name of ["fill-note", "fill-kind"]) {
    mkdirSync(join(db, "migrations", `20261012T0000-${name}`), { recursive: true });
    writeFileSync(join(db, "migrations", `20261012T0000-${name}`, "backfill.ts"), backfillTemplate(name, dialect));
  }
  if (before) asBefore(db);
  const schema = SCHEMA[dialect];
  writeFileSync(
    join(root, "chant.workspace.json"),
    `${JSON.stringify(
      {
        name: "shop",
        schema: 1,
        pins: [{ package: LEXICON, version: lexiconVersion }],
        members: [
          { name: "db", dir: "db", kind: "chant" },
          { name: "app", dir: "app", kind: "other", because: "the service that reads events", links: [{ member: "db", output: `${schema}.events.note` }] },
          { name: "analytics", dir: "analytics", kind: "dbt", fields: { sqlMember: "db", dialect } },
        ],
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app", "README.md"), "The service that reads events.\n");
  mkdirSync(join(root, "analytics", "models", "staging"), { recursive: true });
  writeFileSync(join(root, "analytics", "dbt_project.yml"), "name: analytics\nversion: '1.0'\nprofile: analytics\n");
  writeFileSync(
    join(root, "analytics", "models", "staging", "sources.yml"),
    `version: 2\n\nsources:\n  - name: app\n    schema: ${schema}\n    tables:\n      - name: events\n        columns:\n          - name: id\n          - name: note\n`,
  );
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function check(root: string): { code: number; text: string } {
  const ran = spawnSync(join(repoRoot, "node_modules", ".bin", "chant"), ["workspace", "check"], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 120_000 });
  return { code: ran.status ?? 1, text: `${ran.stdout}${ran.stderr}` };
}

describe.each(["clickhouse", "postgres"] as const)("a %s project as a workspace member (#2)", (dialect) => {
  const schema = SCHEMA[dialect];

  it("exposes its tables and columns, with every Op and backfill exported under a name of its own", () => {
    const db = join(workspace(dialect, {}), "db");
    const exported = [...readdirSync(join(db, "ops")).map((f) => join("ops", f)), ...readdirSync(join(db, "migrations")).filter((d) => d.startsWith("2026")).map((d) => join("migrations", d, "backfill.ts"))].flatMap((f) =>
      [...readFileSync(join(db, f), "utf8").matchAll(/export const (?:\{ op: (\w+) \}|(\w+)) =/g)].map((m) => m[1] ?? m[2]),
    );
    expect(exported).not.toContain("op");
    expect(new Set(exported).size).toBe(exported.length);

    const ran = check(join(db, ".."));
    expect(ran.code, ran.text).toBe(0);
    expect(ran.text).not.toContain("WSP094");
  }, 180_000);

  it("fails chant workspace check for each member that reads a column src/ no longer declares", () => {
    const ran = check(workspace(dialect, false));
    expect(ran.code, ran.text).toBe(1);
    expect(ran.text).toMatch(new RegExp(`app's link to db output ${schema}\\.events\\.note does not resolve.*WSP093`));
    expect(ran.text).toContain("analytics/models/staging/sources.yml");
    expect(ran.text).toMatch(new RegExp(`analytics's link to db output ${schema}\\.events\\.note .*does not resolve`));
  }, 180_000);

  it("reads a project made before #2 too, whose Ops and backfills all export op (chant#3941)", () => {
    const root = workspace(dialect, {}, true);
    expect(readFileSync(join(root, "db", "ops", "watch-dev.op.ts"), "utf8")).toContain("export const { op } =");
    const ran = check(root);
    expect(ran.code, ran.text).toBe(0);
    expect(ran.text).not.toContain("WSP094");
    const dropped = check(workspace(dialect, false, true));
    expect(dropped.code, dropped.text).toBe(1);
    expect(dropped.text).toContain("WSP093");
  }, 180_000);

  it("says where a column went when src/ renames it with a -- previously: hint", () => {
    const ran = check(workspace(dialect, { column: "remark", trailer: " -- previously: note" }));
    expect(ran.code, ran.text).toBe(1);
    expect(ran.text).toContain(`it was renamed to ${schema}.events.remark`);
  }, 180_000);
});
