/**
 * A scratch project made from a fixture, set up the way a team's would be:
 * its own git repository (chant's Op discovery and gate ledger live in git),
 * and a node_modules where `@intentius/sql-yodeler` is this checkout, so
 * `yodel` and `chant` are on PATH from node_modules/.bin as after
 * `npm install`. The yodel bin is the built one (dist/bin.js): run
 * `npm run build` first, which `npm run claims` does.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dialectName, type Ctx } from "./claim.js";
import { endpointEnv } from "./db.js";
import { run, type Ran } from "./exec.js";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface ProjectOptions {
  /** Which Op the project declares: the migrations Op (versioned), the ApplyOp (declarative), or none. */
  ops?: "versioned" | "declarative" | "none";
  /** Leave src/ out, for `yodel init --from`. */
  noSource?: boolean;
  /** The directory under ctx.work (default "project"). */
  name?: string;
}

/** What `yodel apply --json` and `yodel status --json` print, the parts claims read. */
export interface ApplyDoc {
  status?: string;
  approve?: string;
  planDigest?: string;
  gatePlanDigest?: string;
  applied?: Array<{ id: string; checksum: string }>;
  pending?: Array<{ id: string; outOfOrder: boolean; partWay: { resumeAt: number; done: number[]; failedStatement: number | null } | null }>;
  outOfOrder?: string[];
  partWay?: Array<{ id: string; resumeAt: number; failedStatement: number | null }>;
  mismatches?: Array<{ kind: string; id: string }>;
}

export interface MigrationJson {
  id: string;
  parent: string | null;
  checksum: string;
  steps: Array<{ kind: string; sql?: string; rule?: string; class?: string; op?: string; object?: string; name?: string }>;
}

export class Project {
  private constructor(
    readonly ctx: Ctx,
    readonly dir: string,
  ) {}

  get env(): string {
    return this.ctx.env;
  }

  /** Copies the dialect's fixture, renames its environment and database to the claim's, and commits it. */
  static async create(ctx: Ctx, options: ProjectOptions = {}): Promise<Project> {
    const dir = join(ctx.work, options.name ?? "project");
    const from = join(fixtures, dialectName[ctx.dialect]);
    mkdirSync(dir, { recursive: true });
    const ops = options.ops ?? "versioned";
    const copy = (src: string, dest: string) => {
      const text = readFileSync(src, "utf8").replaceAll("CLAIMENV", ctx.env).replaceAll("yodel_34_claim", ctx.db.name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    };
    copy(join(from, "package.json"), join(dir, "package.json"));
    copy(join(from, "chant.config.ts"), join(dir, "chant.config.ts"));
    if (!options.noSource) copy(join(from, "src", "schema.ts"), join(dir, "src", "schema.ts"));
    if (ops !== "none") {
      const opsDir = join(from, `ops-${ops}`);
      for (const f of readdirSync(opsDir)) copy(join(opsDir, f), join(dir, "ops", f.replaceAll("CLAIMENV", ctx.env)));
    }
    linkModules(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\n");
    const p = new Project(ctx, dir);
    await p.git("init", "-q", "-b", "main");
    await p.git("config", "user.name", "yodel claims");
    await p.git("config", "user.email", "yodel-claims@example.invalid");
    await p.git("config", "commit.gpgsign", "false");
    await p.commit("the fixture");
    return p;
  }

  /** The environment every command here runs with. */
  envFor(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {};
    // A run inside CI looks like a person's shell: no CI variables for yodel's forge detection or chant to pick up.
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CI" || k.startsWith("GITHUB_") || k.startsWith("YODEL_")) continue;
      base[k] = v;
    }
    const env: NodeJS.ProcessEnv = {
      ...base,
      ...endpointEnv(),
      YODEL_HISTORY_DATABASE: this.ctx.db.history,
      PATH: [join(this.dir, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) Reflect.deleteProperty(env, k);
      else env[k] = v;
    }
    return env;
  }

  yodel(args: string[], options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<Ran> {
    return run("yodel", args, { cwd: this.dir, env: this.envFor(options.env), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  }

  chant(args: string[]): Promise<Ran> {
    return run("chant", args, { cwd: this.dir, env: this.envFor() });
  }

  async git(...args: string[]): Promise<Ran> {
    const ran = await run("git", args, { cwd: this.dir, env: this.envFor(), timeoutMs: 60_000 });
    if (ran.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.err}`);
    return ran;
  }

  async commit(message: string): Promise<void> {
    await this.git("add", "-A");
    await this.git("commit", "-q", "--allow-empty", "-m", message);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  read(file: string): string {
    return readFileSync(this.path(file), "utf8");
  }

  write(file: string, text: string): void {
    mkdirSync(dirname(this.path(file)), { recursive: true });
    writeFileSync(this.path(file), text);
  }

  /** Replaces `from` with `to` in a file; a `from` that is not there is a setup error, not a verdict. */
  edit(file: string, from: string | RegExp, to: string): void {
    const text = this.read(file);
    const next = text.replace(from, to);
    if (next === text) throw new Error(`edit: ${String(from)} is not in ${file}`);
    this.write(file, next);
  }

  /** The migration directories, oldest first by id. */
  migrationIds(): string[] {
    const dir = this.path("migrations");
    return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "migration.json"))).sort() : [];
  }

  migration(id: string): MigrationJson {
    return JSON.parse(this.read(join("migrations", id, "migration.json"))) as MigrationJson;
  }

  moveMigration(id: string, to: string): void {
    renameSync(this.path("migrations", id), to);
  }

  removeMigration(id: string): void {
    rmSync(this.path("migrations", id), { recursive: true, force: true });
  }

  /** `yodel new <name> --json`; the id written, or undefined when there was no change. */
  async newMigration(name: string, extra: string[] = [], env: Record<string, string | undefined> = {}): Promise<string | undefined> {
    const ran = await this.yodel(["new", name, "--json", ...extra], { env });
    if (ran.code !== 0) throw new Error(`yodel new ${name} exited ${String(ran.code)}`);
    const doc = parse<{ written: boolean; id?: string }>(ran);
    return doc.written ? doc.id : undefined;
  }

  /** Runs a `chant approve ...` command as printed by yodel. */
  async approve(command: string | undefined): Promise<void> {
    if (!command?.startsWith("chant approve ")) throw new Error(`no chant approve command to run: ${String(command)}`);
    const ran = await this.chant(command.split(" ").slice(1));
    if (ran.code !== 0) throw new Error(`${command} exited ${String(ran.code)}`);
  }

  /** `yodel apply <env> --json`. */
  async apply(extra: string[] = [], env: Record<string, string | undefined> = {}): Promise<{ ran: Ran; doc: ApplyDoc }> {
    const ran = await this.yodel(["apply", this.env, "--json", ...extra], { env, timeoutMs: 600_000 });
    return { ran, doc: parseOr<ApplyDoc>(ran, {}) };
  }

  /**
   * What a person does: yodel apply; at the gate, run the chant approve it
   * printed; yodel apply again. Returns the last apply, and the digest
   * approved (when there was a gate).
   */
  async approvedApply(extra: string[] = [], env: Record<string, string | undefined> = {}): Promise<{ ran: Ran; doc: ApplyDoc; approved?: string }> {
    const first = await this.apply(extra, env);
    if (first.ran.code !== 3) return first;
    await this.approve(first.doc.approve);
    const second = await this.apply(extra, env);
    return { ...second, ...(first.doc.planDigest ? { approved: first.doc.planDigest } : {}) };
  }

  /** `yodel status <env> --json`. */
  async status(): Promise<{ ran: Ran; doc: ApplyDoc }> {
    const ran = await this.yodel(["status", this.env, "--json"]);
    return { ran, doc: parseOr<ApplyDoc>(ran, {}) };
  }
}

/** The JSON document a command printed on stdout, typed as the caller reads it. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the document's shape
export function parse<T>(ran: Ran): T {
  const at = ran.out.indexOf("{");
  if (at < 0) throw new Error(`no JSON on stdout (exit ${String(ran.code)})`);
  return JSON.parse(ran.out.slice(at)) as T;
}

function parseOr<T>(ran: Ran, fallback: T): T {
  try {
    return parse<T>(ran);
  } catch {
    return fallback;
  }
}

/**
 * node_modules for a scratch project: every package this checkout has,
 * linked, with @intentius/sql-yodeler being the checkout itself, and a .bin
 * holding chant and yodel.
 */
function linkModules(dir: string): void {
  const from = join(repoRoot, "node_modules");
  const to = join(dir, "node_modules");
  mkdirSync(join(to, "@intentius"), { recursive: true });
  mkdirSync(join(to, ".bin"));
  for (const entry of readdirSync(from)) {
    if (entry === "@intentius" || entry === ".bin" || entry.startsWith(".")) continue;
    symlinkSync(join(from, entry), join(to, entry));
  }
  for (const entry of readdirSync(join(from, "@intentius"))) symlinkSync(join(from, "@intentius", entry), join(to, "@intentius", entry));
  symlinkSync(repoRoot, join(to, "@intentius", "sql-yodeler"));
  symlinkSync("../@intentius/chant/bin/chant", join(to, ".bin", "chant"));
  symlinkSync("../@intentius/sql-yodeler/dist/bin.js", join(to, ".bin", "yodel"));
  if (!existsSync(join(repoRoot, "dist", "bin.js"))) throw new Error("dist/bin.js is missing: run npm run build first");
}

