import { hold, type Claim, type Ctx } from "../../lib/claim.js";
import { parse, Project } from "../../lib/project.js";

interface CheckDoc {
  status: string;
  checked: string[];
  findings: Array<{ rule: string; file?: string; line?: number; silenced?: string }>;
}

const BASE = "20240101120000_create.sql";
const DROP = "20240201120000_drop_nickname.sql";

/**
 * yodel check (#1): a team keeps goose and tries yodel on its pull
 * requests. A goose directory's first migration is on main; the pull
 * request adds a second that drops a column. `yodel check` runs both into
 * the claim's own schema, lints the new one alone, and fails it (exit 1)
 * with a destructive finding on that file's statement. A
 * `-- yodel:allow destructive <reason>` line in the file then silences it.
 * BREAK: yodel.config.ts turns the destructive rule off, so the drop goes
 * unreported.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx, { ops: "none", noSource: true });
  p.write("yodel.config.ts", `export default { check: { dir: "db/migrations" }${ctx.broken ? `, lint: { rules: { destructive: "off" } }` : ""} };\n`);
  p.write(`db/migrations/${BASE}`, "-- +goose Up\nCREATE TABLE users (\n  id bigint PRIMARY KEY,\n  nickname text\n);\n\n-- +goose Down\nDROP TABLE users;\n");
  await p.commit("goose: the users table");
  p.write(`db/migrations/${DROP}`, "-- +goose Up\nALTER TABLE users DROP COLUMN nickname;\n\n-- +goose Down\nALTER TABLE users ADD COLUMN nickname text;\n");

  const ran = await p.yodel(["check", "--env", ctx.env, "--base", "main", "--json"], { timeoutMs: 300_000 });
  const doc = parse<CheckDoc>(ran);
  hold(doc.checked.length === 1 && doc.checked[0] === DROP, `yodel check linted ${JSON.stringify(doc.checked)}, not the new ${DROP} alone`);
  const found = doc.findings.find((f) => f.rule === "destructive");
  hold(ran.code === 1 && found?.file === DROP && found.line === 2, `yodel check exited ${String(ran.code)} with ${JSON.stringify(found)}, not a destructive finding on ${DROP} line 2`);

  // Silenced in the file, the drop fails nothing.
  p.edit(`db/migrations/${DROP}`, "-- +goose Up\n", "-- +goose Up\n-- yodel:allow destructive nickname was never read\n");
  const allowed = await p.yodel(["check", "--env", ctx.env, "--base", "main", "--json"], { timeoutMs: 300_000 });
  const silenced = parse<CheckDoc>(allowed).findings.find((f) => f.rule === "destructive");
  hold(allowed.code === 0 && silenced?.silenced === "nickname was never read", `with a yodel:allow line, yodel check exited ${String(allowed.code)} and the finding is ${JSON.stringify(silenced)}`);
}

export const checkClaim: Claim = {
  name: "check",
  says: "yodel check runs a goose directory's migrations into a throwaway schema and fails the one a pull request adds when it drops a column, on that file's line; a yodel:allow line in the file silences it",
  // How check reads a directory and maps findings is the same on both dialects; the classifier is the one lint's parts prove on each.
  dialects: { pg: body },
};
