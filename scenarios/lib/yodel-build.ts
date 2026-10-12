import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./claim.js";
import { run, type Ran } from "./exec.js";
import type { Project } from "./project.js";

/**
 * A copy of the project's yodel at `<work>/<name>`, with `patch` applied to
 * one file of its build (a part's broken build), and `ask.mjs` beside it:
 * yodel's CLI with a terminal that answers every question with argv[2].
 */
export function yodelBuild(ctx: Ctx, p: Project, name: string, patch?: { file: string; from: string; to: string }): { ask: (answer: string, args: string[]) => Promise<Ran>; bin: string } {
  const root = join(ctx.work, name);
  if (!existsSync(root)) {
    const pkg = realpathSync(p.path("node_modules", "@intentius", "sql-yodeler"));
    mkdirSync(root, { recursive: true });
    cpSync(join(pkg, "dist"), join(root, "dist"), { recursive: true });
    copyFileSync(join(pkg, "package.json"), join(root, "package.json"));
    symlinkSync(p.path("node_modules"), join(root, "node_modules"));
    mkdirSync(join(root, "bin"));
    symlinkSync("../dist/bin.js", join(root, "bin", "yodel"));
    if (patch) {
      const file = join(root, "dist", patch.file);
      const text = readFileSync(file, "utf8");
      if (!text.includes(patch.from)) throw new Error(`${patch.from} is not in ${file}; the broken build cannot be made`);
      writeFileSync(file, text.replace(patch.from, patch.to));
    }
    writeFileSync(
      join(root, "ask.mjs"),
      `import { register } from "tsx/esm/api";
register();
const { main } = await import("./dist/cli.js");
const [answer, ...args] = process.argv.slice(2);
process.exitCode = await main(args, {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  ask: async (q) => { process.stderr.write(q + answer + "\\n"); return answer; },
});
`,
    );
  }
  return {
    ask: (answer, args) => run("node", [join(root, "ask.mjs"), answer, ...args], { cwd: p.dir, env: p.envFor(), timeoutMs: 600_000 }),
    // A directory holding this build as `yodel`, to put first on a pipeline's PATH.
    bin: join(root, "bin"),
  };
}
