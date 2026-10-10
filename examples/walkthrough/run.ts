/**
 * Runs an example's walkthrough against a server, step by step, in a
 * temporary copy of the project, and checks each command's exit code and
 * output. With `--write` it also writes what ran, with the real output, to
 * the example's README.md, and copies the project as the walkthrough left it
 * (src/, migrations/, ops/, backfills/) back into the example, so the
 * committed example is the one the README shows being made.
 *
 *   npm run build
 *   YODEL_E2E_CLICKHOUSE_URL=http://<host>:8123 npx tsx examples/walkthrough/run.ts clickhouse [--write]
 *   YODEL_E2E_POSTGRES_URL=postgres://<host>:5432/postgres YODEL_E2E_POSTGRES_USER=postgres \
 *     YODEL_E2E_POSTGRES_PASSWORD=chant npx tsx examples/walkthrough/run.ts postgres [--write]
 *
 * test/e2e/examples.test.ts runs the same, without --write, when those
 * variables are set.
 *
 * The temporary project gets a node_modules made of links into this repo's
 * (chant, the sql lexicon, tsx) with this repo as @intentius/sql-yodeler, so
 * `npx yodel` and `npx chant` resolve as they do after `npm install` in the
 * example. It is a git repository with a bare `origin`, since chant keeps
 * approvals on the `chant/lifecycle` branch.
 *
 * The commands run as user `yodel` on host `example` (USER, and os.hostname()
 * through a preload), so the names in approvals and in the history's
 * applied_by are the same on every machine and never the local user's.
 *
 * A run step with `quote` is also quoted in docs/<quote>: --write rewrites
 * that console block from the run, and test/docs.test.ts checks it against
 * the README (or, for a walkthrough with no README, against a fresh run).
 *
 *   npx tsx examples/walkthrough/run.ts template [--write]
 *
 * runs examples/walkthrough/template.ts, a project made from
 * templates/clickhouse, which needs no server and only refreshes docs quotes.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export type Step =
  /** Markdown, as is. */
  | { say: string }
  /** Writes a file (from `content`, or from the committed example when `content` is left out) and shows it. */
  | { file: string; content?: string; show?: boolean }
  /** Replaces `from` with `to` in a file, and shows the file. */
  | { edit: string; from: string; to: string; show?: boolean }
  /** Removes a file or directory. */
  | { rm: string }
  /** Shows a file the walkthrough made, e.g. a migration's migration.sql. `{id:<name>}` names a migration. */
  | { cat: string; lang?: string }
  /**
   * Runs a shell command in the project (in `cwd` under it, when given).
   * `{id:<name>}` is the id of the migration named <name>; `{approve}` is the
   * `chant approve` command the last run printed, run with npx; `{clone}` is
   * this repository, shown as `<clone>`. `quote` names the docs/ page that
   * quotes the command and its output.
   */
  | { run: string; code: number; expect?: Array<string | RegExp>; hide?: boolean; cwd?: string; quote?: string }
  /** Runs SQL on the server, as someone working out of band would. */
  | { sql: string; hide?: boolean; showResult?: boolean };

export interface Walkthrough {
  dialect: "clickhouse" | "postgres";
  /** False when the walkthrough writes no README and keeps nothing: it only feeds docs quotes. */
  readme?: boolean;
  /** The README's text above the steps. */
  intro: string;
  /** Files copied from the committed example before the first step. */
  start: string[];
  /** What the walkthrough leaves that is copied back into the example with --write. */
  keep: string[];
  /** The environment the commands run with, besides PATH. */
  env: () => Record<string, string>;
  /** Runs SQL on the server and returns its rows as text. */
  sql: (sql: string) => Promise<string>;
  /** Drops what the walkthrough makes on the server. */
  reset: () => Promise<void>;
  /**
   * Text replaced in what the README and docs show, after <tmp> and <clone>:
   * for example the server's real address, shown as the one a reader has.
   */
  shown?: () => Array<[string, string]>;
  steps: Step[];
}

export interface Ran {
  step: Step;
  command?: string;
  output?: string;
  code?: number;
}

const exampleDir = (w: Walkthrough) => join(repoRoot, "examples", w.dialect);
const clone = repoRoot.replace(/\/$/, "");

/** Who the commands run as. Never the local user or host: the transcripts are published. */
export const RUN_AS = { user: "yodel", host: "example" };

/** A node_modules whose entries link to this repo's, with this repo as @intentius/sql-yodeler and its bin as yodel. */
function nodeModules(dir: string): void {
  const from = join(repoRoot, "node_modules");
  const to = join(dir, "node_modules");
  mkdirSync(join(to, ".bin"), { recursive: true });
  mkdirSync(join(to, "@intentius"), { recursive: true });
  for (const e of readdirSync(from)) {
    if (e === ".bin" || e === "@intentius" || e.startsWith(".")) continue;
    symlinkSync(join(from, e), join(to, e));
  }
  for (const e of readdirSync(join(from, "@intentius"))) symlinkSync(join(from, "@intentius", e), join(to, "@intentius", e));
  symlinkSync(repoRoot.replace(/\/$/, ""), join(to, "@intentius", "sql-yodeler"));
  for (const e of readdirSync(join(from, ".bin"))) symlinkSync(realpathSync(join(from, ".bin", e)), join(to, ".bin", e));
  symlinkSync(join(repoRoot, "dist", "bin.js"), join(to, ".bin", "yodel"));
}

function sh(cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 900_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", `${cmd} 2>&1`], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (output += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (output += c));
    const timer = setTimeout(() => {
      output += `\n[killed after ${String(timeoutMs / 1000)}s]\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), output });
    });
  });
}

const git = (cwd: string, args: string) => sh(`git ${args}`, cwd, process.env);

function migrationId(dir: string, name: string): string {
  const migrations = join(dir, "migrations");
  const found = existsSync(migrations) ? readdirSync(migrations).filter((d) => d.endsWith(`-${name}`)).sort() : [];
  const id = found.at(-1);
  if (!id) throw new Error(`no migration named ${name} in ${migrations}`);
  return id;
}

/** Runs the walkthrough. Throws at the first step whose exit code or output is not the expected one. */
export async function runWalkthrough(
  w: Walkthrough,
  log: (line: string) => void = () => undefined,
  options: { start?: string[]; steps?: Step[] } = {},
): Promise<{ ran: Ran[]; dir: string; dispose: () => void }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `yodel-example-${w.dialect}-`)));
  log(`# in ${root}`);
  const dir = join(root, w.dialect);
  const origin = join(root, "origin.git");
  mkdirSync(dir);
  for (const f of options.start ?? w.start) cpSync(join(exampleDir(w), f), join(dir, f), { recursive: true });
  nodeModules(dir);
  await git(root, `init -q --bare -b main ${origin}`);
  for (const args of ["init -q -b main", "config user.name example", "config user.email example@example.invalid", `remote add origin ${origin}`, "add -A", "commit -q -m start", "push -q origin main"]) {
    const r = await git(dir, args);
    if (r.code !== 0) throw new Error(`git ${args}: ${r.output}`);
  }
  const preload = join(root, "run-as.cjs");
  writeFileSync(
    preload,
    `const os = require("node:os");\nos.hostname = () => ${JSON.stringify(RUN_AS.host)};\nrequire("node:module").syncBuiltinESMExports();\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...w.env(),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    USER: RUN_AS.user,
    LOGNAME: RUN_AS.user,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${preload}`.trim(),
  };
  delete env.YODEL_HISTORY_DATABASE;
  delete env.YODEL_TOPOLOGY;
  delete env.GITHUB_ACTOR;
  delete env.GITLAB_USER_LOGIN;

  await w.reset();
  const ran: Ran[] = [];
  let lastApprove: string | undefined;
  const fill = (text: string) =>
    text
      .replace(/\{clone\}/g, clone)
      .replace(/\{id:([a-z0-9_-]+)\}/g, (_, name: string) => migrationId(dir, name))
      .replace(/\{approve\}/g, () => {
        if (!lastApprove) throw new Error("no chant approve command printed yet");
        return `npx ${lastApprove}`;
      });

  for (const step of options.steps ?? w.steps) {
    if ("say" in step) {
      ran.push({ step });
    } else if ("file" in step) {
      const content = step.content ?? readFileSync(join(exampleDir(w), step.file), "utf8");
      mkdirSync(dirname(join(dir, step.file)), { recursive: true });
      writeFileSync(join(dir, step.file), content);
      ran.push({ step, output: content });
    } else if ("edit" in step) {
      const rel = fill(step.edit);
      const path = join(dir, rel);
      const text = readFileSync(path, "utf8");
      if (!text.includes(step.from)) throw new Error(`edit ${rel}: ${JSON.stringify(step.from)} is not in:\n${text}`);
      const next = text.replace(step.from, step.to);
      writeFileSync(path, next);
      ran.push({ step, command: rel, output: next });
    } else if ("rm" in step) {
      const rel = fill(step.rm);
      rmSync(join(dir, rel), { recursive: true, force: true });
      ran.push({ step, command: rel });
    } else if ("cat" in step) {
      const path = fill(step.cat);
      ran.push({ step, command: path, output: readFileSync(join(dir, path), "utf8") });
    } else if ("sql" in step) {
      const output = await w.sql(step.sql);
      ran.push({ step, output });
    } else {
      const command = fill(step.run);
      const shownCommand = command.split(clone).join("<clone>");
      log(`$ ${shownCommand}`);
      const { code, output } = await sh(command, step.cwd ? join(dir, step.cwd) : dir, env);
      let shown = output.split(root).join("<tmp>").split(clone).join("<clone>");
      for (const [from, to] of w.shown?.() ?? []) if (from) shown = shown.split(from).join(to);
      log(shown.trimEnd());
      ran.push({ step, command: shownCommand, output: shown, code });
      const approve = /chant approve \S+ \S+ --plan jcs1-sha256:[0-9a-f]{64}/.exec(output);
      if (approve) lastApprove = approve[0];
      if (code !== step.code) throw new Error(`${command}: exit ${String(code)}, expected ${String(step.code)}\n${output}`);
      for (const e of step.expect ?? []) {
        const ok = typeof e === "string" ? output.includes(e) : e.test(output);
        if (!ok) throw new Error(`${command}: the output does not have ${String(e)}\n${output}`);
      }
    }
  }
  return { ran, dir, dispose: () => { rmSync(root, { recursive: true, force: true }); } };
}

const fence = (text: string, lang = "") => {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${text.replace(/\n+$/, "")}\n${ticks}`;
};
const langOf = (path: string) => (path.endsWith(".ts") ? "ts" : path.endsWith(".sql") ? "sql" : path.endsWith(".json") ? "json" : "");

const consoleBlock = (r: Ran) => {
  const exit = r.code === 0 ? "" : `\n[exit ${String(r.code)}]`;
  return `$ ${r.command ?? ""}\n${(r.output ?? "").trimEnd()}${exit}`;
};

export interface Quote {
  /** The docs/ page. */
  page: string;
  /** The block's first command, as its `$ ` line shows it. */
  command: string;
  /** Which block on the page starting with that command: 0 for the first. */
  nth: number;
  /** The block, without its fence. */
  text: string;
}

/**
 * The docs quotes a run makes: each run of consecutive steps quoted on the
 * same page is one console block.
 */
export function quotes(ran: Ran[]): Quote[] {
  const out: Array<{ page: string; ran: Ran[] }> = [];
  let open: { page: string; ran: Ran[] } | undefined;
  for (const r of ran) {
    const s = r.step;
    if ("run" in s && s.quote) {
      if (open?.page !== s.quote) out.push((open = { page: s.quote, ran: [] }));
      open.ran.push(r);
    } else {
      open = undefined;
    }
  }
  const seen = new Map<string, number>();
  return out.map((q) => {
    const command = q.ran[0]?.command ?? "";
    const key = `${q.page}\n${command}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    return { page: q.page, command, nth, text: q.ran.map(consoleBlock).join("\n") };
  });
}

/** The `nth` console block in `text` whose first line is `$ <command>` (0, the first): where its body starts and ends. */
export function findBlock(text: string, command: string, nth = 0): { start: number; end: number } | undefined {
  const head = "```console\n$ " + command + "\n";
  let at = text.indexOf(head);
  for (let i = 0; i < nth && at !== -1; i++) at = text.indexOf(head, at + head.length);
  if (at === -1) return undefined;
  const start = at + "```console\n".length;
  const end = text.indexOf("\n```", start);
  return end === -1 ? undefined : { start, end };
}

/** Rewrites each quoted block in docs/ from the run. */
export function writeQuotes(ran: Ran[]): string[] {
  const pages: string[] = [];
  for (const q of quotes(ran)) {
    const path = join(repoRoot, "docs", q.page);
    const text = readFileSync(path, "utf8");
    const b = findBlock(text, q.command, q.nth);
    if (!b) throw new Error(`docs/${q.page} has no console block ${String(q.nth + 1)} starting with "$ ${q.command}"`);
    writeFileSync(path, text.slice(0, b.start) + q.text + text.slice(b.end));
    pages.push(`docs/${q.page}`);
  }
  return pages;
}

/** The README: the intro, then each step as Markdown. */
export function renderReadme(w: Walkthrough, ran: Ran[]): string {
  const parts = [w.intro.trim()];
  for (const r of ran) {
    const s = r.step;
    if ("say" in s) parts.push(s.say.trim());
    else if ("file" in s && s.show !== false) parts.push(`\`${s.file}\`:\n\n${fence(r.output ?? "", langOf(s.file))}`);
    else if ("edit" in s && s.show !== false) parts.push(`\`${r.command ?? s.edit}\` now:\n\n${fence(r.output ?? "", langOf(s.edit))}`);
    else if ("cat" in s) parts.push(`\`${r.command ?? ""}\`:\n\n${fence(r.output ?? "", s.lang ?? langOf(s.cat))}`);
    else if ("sql" in s && !s.hide) parts.push(fence(s.sql.trim(), "sql") + (s.showResult ? `\n\n${fence(r.output ?? "")}` : ""));
    else if ("run" in s && !s.hide) parts.push(fence(consoleBlock(r), "console"));
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * The committed example, as it is: lint passes, its migrations are up to
 * date with src/, and they apply to an empty server behind the gate, leaving
 * no drift.
 */
export const committedSteps: Step[] = [
  { run: "npx yodel lint", code: 0, expect: ["0 errors"] },
  { run: "npx yodel new check", code: 0, expect: ["No changes"] },
  { run: "npx yodel apply dev", code: 3, expect: ["is waiting at gate"] },
  { run: "{approve}", code: 0 },
  { run: "npx yodel apply dev", code: 0, expect: ["Applied: "] },
  { run: "npx yodel status dev", code: 0 },
  { run: "npx yodel drift dev", code: 0 },
];

/** Runs {@link committedSteps} in a copy of the committed example. */
export function runCommitted(w: Walkthrough, log?: (line: string) => void): ReturnType<typeof runWalkthrough> {
  const start = [...new Set([...w.start, ...w.keep])].filter((f) => existsSync(join(exampleDir(w), f)));
  return runWalkthrough(w, log, { start, steps: committedSteps });
}

/** Copies what the walkthrough left back into the example. */
export function keep(w: Walkthrough, dir: string): void {
  for (const k of w.keep) {
    const target = join(exampleDir(w), k);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(join(dir, k))) cpSync(join(dir, k), target, { recursive: true });
  }
}

export async function load(name: string): Promise<Walkthrough> {
  const mod = (await import(pathToFileURL(join(repoRoot, "examples", "walkthrough", `${name}.ts`)).href)) as { walkthrough: Walkthrough };
  return mod.walkthrough;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2] ?? "";
  const write = process.argv.includes("--write");
  const w = await load(name);
  const { ran, dir, dispose } = await runWalkthrough(w, (l) => { console.log(l); });
  try {
    if (write) {
      if (w.readme !== false) {
        keep(w, dir);
        writeFileSync(join(exampleDir(w), "README.md"), renderReadme(w, ran));
        console.log(`wrote ${relative(process.cwd(), join(exampleDir(w), "README.md"))}`);
      }
      for (const page of writeQuotes(ran)) console.log(`wrote ${page}`);
    }
  } finally {
    dispose();
  }
}
