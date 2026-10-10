/**
 * Each starter template, made into a project the way a user makes one, with
 * the @intentius/sql-yodeler that its range resolves to on npm (#131).
 *
 *   npm run templates:check
 *
 * Inside this repository the templates are checked against ./src
 * (tsconfig.json's paths), and the template claims pack this checkout into
 * the project, so a template that needs yodel not yet released passes both
 * and still breaks `chant init --from INTENTIUS/sql-yodeler@main#templates/<dialect>`.
 * Here, for each template: `chant init --from` this checkout's template,
 * `npm install` (the range, from the registry), `git init`, `yodel ci --check`,
 * `npm run typecheck`, `just up`'s second half against a throwaway server
 * (Docker, the emulator's image: scripts/local.ts makes the read-only
 * reader there, and with the .env lines it prints `yodel status dev` exits
 * 0, so yodel does not refuse dev's reader and writer as one user, #139),
 * `yodel new init` and `yodel lint`.
 *
 * One exception: when no release on npm satisfies the range and the range's
 * lowest version is this checkout's package.json version, this checkout is
 * the release that ships it (AGENTS.md, Releasing), so the project takes
 * `npm pack` of this checkout instead. That needs `npm run build` first.
 * Once the release is on npm, the same check takes it from the registry.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLICKHOUSE_EMULATOR_SPEC, POSTGRES_EMULATOR_SPEC } from "@intentius/chant-lexicon-sql/op/activities";

const PKG = "@intentius/sql-yodeler";
const root = fileURLToPath(new URL("../", import.meta.url));
const ownVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const chant = join(root, "node_modules", ".bin", "chant");

class Failed extends Error {}

function run(cmd: string, args: string[], cwd: string, capture = false, extraEnv: Record<string, string> = {}): string {
  process.stdout.write(`$ ${[cmd, ...args].join(" ")}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_") && k !== "INIT_CWD"));
  const ran = spawnSync(cmd, args, { cwd, env: { ...env, NO_COLOR: "1", ...extraEnv }, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (ran.status !== 0) throw new Failed(`${cmd} ${args.join(" ")} exited ${String(ran.status ?? ran.signal)}`);
  return capture ? ran.stdout : "";
}

/** The released versions on npm that satisfy range; none when the registry has none. */
function released(range: string): string[] {
  const ran = spawnSync("npm", ["view", `${PKG}@${range}`, "version", "--json"], { encoding: "utf8" });
  const out = ran.stdout.trim();
  if (ran.status !== 0 || out === "") return [];
  const parsed = JSON.parse(out) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** A throwaway server from the emulator's image, on a free port of 127.0.0.1, removed by `close`. */
async function throwawayServer(template: string): Promise<{ url: string; close: () => void }> {
  const spec = template === "clickhouse" ? CLICKHOUSE_EMULATOR_SPEC : POSTGRES_EMULATOR_SPEC;
  const name = `yodel-templates-check-${template}-${randomBytes(3).toString("hex")}`;
  const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
  const started = docker(["run", "--detach", "--rm", "--name", name, "--publish", `127.0.0.1::${String(spec.containerPort)}`, ...(spec.runArgs ?? []), spec.image]);
  if (started.status !== 0) throw new Failed(`could not start a throwaway ${template} server: ${started.stderr.trim()}`);
  const close = () => {
    docker(["rm", "--force", "--volumes", name]);
  };
  const port = /:(\d+)\s*$/m.exec(docker(["port", name, `${String(spec.containerPort)}/tcp`]).stdout)?.[1];
  if (!port) {
    close();
    throw new Failed(`docker did not publish ${name}'s port`);
  }
  const url = template === "clickhouse" ? `http://127.0.0.1:${port}` : `postgres://127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 90; i++) {
    const ready =
      template === "clickhouse"
        ? await fetch(`${url}/ping`).then((r) => r.ok, () => false)
        : docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).status === 0;
    if (ready) return { url, close };
    await sleep(1000);
  }
  close();
  throw new Failed(`the throwaway ${template} server ${name} did not come up`);
}

/**
 * `just up` after `chant emulator up`, against a throwaway server: the
 * project's scripts/local.ts makes the reader there and prints the .env
 * lines; with them, `yodel status dev` reads as the reader and exits 0.
 */
async function upThenStatus(template: string, work: string, dir: string): Promise<void> {
  const server = await throwawayServer(template);
  try {
    const up = join(work, "up.mts");
    writeFileSync(
      up,
      `const local = await import(${JSON.stringify(pathToFileURL(join(dir, "scripts", "local.ts")).href)});\n` +
        `await local.makeReader(${JSON.stringify(template)}, new URL(${JSON.stringify(server.url)}));\n` +
        `for (const line of local.envLines(${JSON.stringify(template)})) console.log(line);\n`,
    );
    const lines = run("npx", ["tsx", up], dir, true).trim().split("\n");
    const env: Record<string, string> = { [`DEV_${template.toUpperCase()}_URL`]: server.url };
    for (const line of lines) {
      const at = line.indexOf("=");
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    const p = `DEV_${template.toUpperCase()}`;
    if (!env[`${p}_READER_USER`] || env[`${p}_READER_USER`] === env[`${p}_WRITER_USER`]) throw new Failed(`scripts/local.ts printed ${String(env[`${p}_READER_USER`])} as dev's reader and ${String(env[`${p}_WRITER_USER`])} as its writer, not two users`);
    run("npx", ["yodel", "status", "dev"], dir, false, env);
  } finally {
    server.close();
  }
}

async function check(template: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), `yodel-template-${template}-`));
  try {
    run(chant, ["init", "--from", `${root}#templates/${template}`, "project"], work);
    const dir = join(work, "project");
    const range = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string | undefined> }).dependencies[PKG] ?? "";
    if (!/^\^\d+\.\d+\.\d+$/.test(range)) throw new Failed(`templates/${template}/package.json takes ${PKG} as "${range}", not a caret range of a release`);
    const versions = released(range);
    if (versions.length > 0) {
      process.stdout.write(`${PKG}@${range} resolves on npm (${versions.join(", ")})\n`);
      run("npm", ["install", "--no-audit", "--no-fund"], dir);
    } else if (range.slice(1) === ownVersion) {
      process.stdout.write(`${PKG}@${range} is not on npm yet, and this checkout is ${ownVersion}, the release that ships it: the project takes npm pack of this checkout\n`);
      run("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", work], root, true);
      const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
      if (tgz === undefined) throw new Failed("npm pack of this checkout wrote no .tgz");
      run("npm", ["install", "--no-audit", "--no-fund", join(work, tgz)], dir);
    } else {
      throw new Failed(`no release of ${PKG} on npm satisfies ${range}, and this checkout is ${ownVersion}, not the release that ships it`);
    }
    const installed = (JSON.parse(readFileSync(join(dir, "node_modules", "@intentius", "sql-yodeler", "package.json"), "utf8")) as { version: string }).version;
    process.stdout.write(`the project has ${PKG} ${installed}\n`);
    // chant finds Ops from the git root, so yodel ci needs a repository.
    run("git", ["init", "-q", "-b", "main"], dir);
    run("npx", ["yodel", "ci", "--check"], dir);
    run("npm", ["run", "typecheck"], dir);
    // Before the first migration, so a reader that yodel takes leaves nothing pending: exit 0.
    await upThenStatus(template, work, dir);
    run("npx", ["yodel", "new", "init"], dir);
    run("npx", ["yodel", "lint"], dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const failed: string[] = [];
for (const template of ["clickhouse", "postgres"]) {
  process.stdout.write(`\n== templates/${template}\n`);
  try {
    await check(template);
    process.stdout.write(`templates/${template}: works with the ${PKG} its range resolves to\n`);
  } catch (err) {
    if (!(err instanceof Failed)) throw err;
    process.stderr.write(`templates/${template}: ${err.message}\n`);
    failed.push(template);
  }
}
if (failed.length > 0) {
  process.stderr.write(
    `\n${failed.map((t) => `templates/${t}`).join(" and ")} did not work with the published ${PKG} their range resolves to.\n` +
      `A template change that needs unreleased yodel ships with the release that has it (AGENTS.md, Releasing).\n`,
  );
  process.exit(1);
}
