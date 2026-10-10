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
 * A run or cat step with `quote: "<page>#<id>"` is also quoted in
 * docs/<page>, in the block that follows the line
 * `<!-- quote: <walkthrough>#<id> -->`. Consecutive steps with the same quote
 * are one block there, and a run step's `excerpt` keeps only part of its
 * output. --write rewrites each such block from the run, and the README marks
 * the same steps, so test/docs.test.ts checks every quote against the README
 * (or, for a walkthrough with no README, against a fresh run).
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
  | { file: string; content?: string; show?: boolean; quote?: Quoted }
  /** Replaces `from` with `to` in a file, and shows the file. */
  | { edit: string; from: string; to: string; show?: boolean; quote?: Quoted }
  /** Removes a file or directory. */
  | { rm: string }
  /** Shows a file the walkthrough made, e.g. a migration's migration.sql. `{id:<name>}` names a migration. */
  | { cat: string; lang?: string; quote?: Quoted }
  /**
   * Runs a shell command in the project (in `cwd` under it, when given).
   * `{id:<name>}` is the id of the migration named <name>; `{approve}` is the
   * `chant approve` command the last run printed, run with npx; `{clone}` is
   * this repository, shown as `<clone>`. `quote` names the docs/ block that
   * quotes the command and its output.
   */
  | { run: string; code: number; expect?: Array<string | RegExp>; hide?: boolean; cwd?: string; quote?: Quoted }
  /** Runs SQL on the server, as someone working out of band would. A quote shows the result, so it needs `showResult`. */
  | { sql: string; hide?: boolean; showResult?: boolean; quote?: Quoted };

/**
 * The part of a command's output a docs quote shows: from the first line that
 * contains `from` (else the first line) to the first line at or after it that
 * contains `to` (else the last). A cut is shown as `...`.
 */
export interface Excerpt {
  from?: string;
  to?: string;
}

/**
 * Where a step is quoted in docs/: `<page>#<id>`, or that with the excerpt
 * of the step's output the quote shows. A step can be quoted in more than
 * one place.
 */
export type QuoteAt = string | { at: string; excerpt?: Excerpt };
export type Quoted = QuoteAt | QuoteAt[];

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

/** `lines` cut to `e`, a cut shown as `...`. */
function cut(lines: string[], e: Excerpt, whole: string): string[] {
  const find = (text: string, from: number) => lines.findIndex((l, i) => i >= from && l.includes(text));
  const a = e.from === undefined ? 0 : find(e.from, 0);
  if (a === -1) throw new Error(`excerpt: no line has ${JSON.stringify(e.from)} in:\n${whole}`);
  const b = e.to === undefined ? lines.length - 1 : find(e.to, a);
  if (b === -1) throw new Error(`excerpt: no line from ${JSON.stringify(e.from ?? "the start")} on has ${JSON.stringify(e.to)} in:\n${whole}`);
  return [...(a > 0 ? ["..."] : []), ...lines.slice(a, b + 1), ...(b < lines.length - 1 ? ["..."] : [])];
}

/**
 * What a quote shows of a step's block: a console block (`$ <command>`, the
 * output, `[exit <code>]`) keeps its first and exit lines, and any other block
 * is cut as a whole.
 */
export function excerpt(block: string, e: Excerpt | undefined, isConsole: boolean): string {
  if (!e) return block;
  const lines = block.split("\n");
  if (!isConsole) return cut(lines, e, block).join("\n");
  const head = lines[0] ?? "";
  const body = lines.slice(1);
  const exit = body.length && /^\[exit \d+\]$/.test(body.at(-1) ?? "") ? body.pop() : undefined;
  return [head, ...cut(body, e, block), ...(exit ? [exit] : [])].join("\n");
}

/** `<page>#<id>`, split. */
export function parseQuote(quote: string): { page: string; id: string } {
  const m = /^([\w-]+\.md)#([a-z0-9-]+)$/.exec(quote);
  if (!m?.[1] || !m[2]) throw new Error(`quote ${JSON.stringify(quote)}: write <page>.md#<id>`);
  return { page: m[1], id: m[2] };
}

/** The line that marks a quoted block, in docs/ and in the README. */
export const marker = (walkthrough: string, id: string) => `<!-- quote: ${walkthrough}#${id} -->`;

/** A step's quotes, each as `{ at, excerpt }`. */
export function quotesOf(step: Step): Array<{ at: string; excerpt?: Excerpt }> {
  const q = "say" in step || "rm" in step ? undefined : step.quote;
  if (!q) return [];
  return (Array.isArray(q) ? q : [q]).map((x) => (typeof x === "string" ? { at: x } : x));
}

/** One quoted block: its page and id, and the steps it shows, in order. */
export interface QuoteGroup {
  page: string;
  id: string;
  members: Array<{ index: number; step: Step; excerpt?: Excerpt | undefined }>;
}

/** The quoted blocks of a list of steps: consecutive steps quoted at the same place are one block. */
export function quoteGroups(steps: Step[]): QuoteGroup[] {
  const groups = new Map<string, QuoteGroup & { last: number }>();
  steps.forEach((step, index) => {
    for (const q of quotesOf(step)) {
      const g = groups.get(q.at);
      if (g && g.last !== index - 1) throw new Error(`quote ${q.at} is on steps that are not consecutive`);
      if (g) {
        g.members.push({ index, step, excerpt: q.excerpt });
        g.last = index;
      } else {
        groups.set(q.at, { ...parseQuote(q.at), members: [{ index, step, excerpt: q.excerpt }], last: index });
      }
      if ("sql" in step && !step.showResult) throw new Error(`quote ${q.at}: a quoted sql step needs showResult`);
    }
  });
  return [...groups.values()].map((g) => ({ page: g.page, id: g.id, members: g.members }));
}

/** The block a step shows in the README (without its fence). */
export function shownBlock(r: Ran): string {
  const s = r.step;
  if ("run" in s) return consoleBlock(r);
  return (r.output ?? "").replace(/\n+$/, "");
}

export interface Quote {
  /** The docs/ page. */
  page: string;
  /** The quote's id: the page's block is the one after {@link marker}. */
  id: string;
  /** The block, without its fence. */
  text: string;
}

/** The docs quotes a run makes. */
export function quotes(ran: Ran[]): Quote[] {
  return quoteGroups(ran.map((r) => r.step)).map((g) => ({
    page: g.page,
    id: g.id,
    text: g.members.map((m) => excerpt(shownBlock(ran[m.index] as Ran), m.excerpt, "run" in m.step)).join("\n"),
  }));
}

const MARKER_LINE = /^<!-- quote: [\w-]+#[a-z0-9-]+ -->\n/;

/** The fenced block after the line `mark` (and any other marker lines) in `text`, from `from` on: where its body starts and ends. */
export function findMarked(text: string, mark: string, from = 0): { start: number; end: number } | undefined {
  const at = text.indexOf(`${mark}\n`, from);
  if (at === -1) return undefined;
  let pos = at + mark.length + 1;
  for (let m = MARKER_LINE.exec(text.slice(pos)); m; m = MARKER_LINE.exec(text.slice(pos))) pos += m[0].length;
  const fence = /^(`{3,})[\w-]*\n/.exec(text.slice(pos));
  if (!fence?.[1]) throw new Error(`${mark} is not followed by a fenced block`);
  const start = pos + fence[0].length;
  const close = `\n${fence[1]}\n`;
  const end = text.slice(start - 1).startsWith(close) ? start - 1 : text.indexOf(close, start);
  return end === -1 ? undefined : { start, end };
}

/** Rewrites each quoted block in docs/ from the run. */
export function writeQuotes(name: string, ran: Ran[]): string[] {
  const pages: string[] = [];
  for (const q of quotes(ran)) {
    const path = join(repoRoot, "docs", q.page);
    const text = readFileSync(path, "utf8");
    const b = findMarked(text, marker(name, q.id));
    if (!b) throw new Error(`docs/${q.page} has no block after ${marker(name, q.id)}`);
    writeFileSync(path, text.slice(0, b.start) + q.text + text.slice(b.end));
    pages.push(`docs/${q.page}`);
  }
  return pages;
}

/** The README: the intro, then each step as Markdown, a quoted step's block after its markers. */
export function renderReadme(name: string, w: Walkthrough, ran: Ran[]): string {
  const parts = [w.intro.trim()];
  const mark = (s: Step) => quotesOf(s).map((q) => `${marker(name, parseQuote(q.at).id)}\n`).join("");
  for (const r of ran) {
    const s = r.step;
    if ("say" in s) parts.push(s.say.trim());
    else if ("file" in s && s.show !== false) parts.push(`\`${s.file}\`:\n\n${mark(s)}${fence(r.output ?? "", langOf(s.file))}`);
    else if ("edit" in s && s.show !== false) parts.push(`\`${r.command ?? s.edit}\` now:\n\n${mark(s)}${fence(r.output ?? "", langOf(s.edit))}`);
    else if ("cat" in s) parts.push(`\`${r.command ?? ""}\`:\n\n${mark(s)}${fence(r.output ?? "", s.lang ?? langOf(s.cat))}`);
    else if ("sql" in s && !s.hide) parts.push(fence(s.sql.trim(), "sql") + (s.showResult ? `\n\n${mark(s)}${fence(r.output ?? "")}` : ""));
    else if ("run" in s && !s.hide) parts.push(mark(s) + fence(consoleBlock(r), "console"));
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
        writeFileSync(join(exampleDir(w), "README.md"), renderReadme(name, w, ran));
        console.log(`wrote ${relative(process.cwd(), join(exampleDir(w), "README.md"))}`);
      }
      for (const page of new Set(writeQuotes(name, ran))) console.log(`wrote ${page}`);
    }
  } finally {
    dispose();
  }
}
