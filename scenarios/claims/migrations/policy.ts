import { hold, type Claim, type Ctx } from "../../lib/claim.js";
import { parse, Project } from "../../lib/project.js";

/** The project's own check (#227): every table has `created_at timestamptz NOT NULL`, read through the sql lexicon's read API. */
const POLICY = `import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { canonicalPostgresType, readPostgres } from "@intentius/chant-lexicon-sql/read";

const TZ = canonicalPostgresType("timestamptz");

export const createdAt: PostSynthCheck = {
  id: "ORG-CREATED-AT",
  description: "every table has created_at timestamptz NOT NULL",
  check: (ctx) =>
    readPostgres(ctx).tables
      .filter((t) => {
        const c = t.column("created_at");
        return !c || c.typeName !== TZ || c.nullable;
      })
      .map((t) => ({ checkId: "ORG-CREATED-AT", severity: "error", entity: t.export, message: t.qualifiedName + " needs created_at timestamptz NOT NULL" })),
};
`;

/** The same check with its rule taken out: it reports nothing. */
const WEAKENED = POLICY.replace(/check: \(ctx\) =>[\s\S]*\n};/, "check: () => [],\n};");
if (WEAKENED === POLICY || !WEAKENED.includes("check: () => []")) throw new Error("the weakened policy is the policy itself; the broken run would prove nothing");

interface LintDoc {
  findings: Array<{ rule: string; migration?: string; step?: number; object?: string; silenced?: string }>;
}

/**
 * A project's own column rule (#227). chant.config.ts `lint.policies`
 * names a check that every table has `created_at timestamptz NOT NULL`. The
 * first migration's `orders` has no such column, so `yodel lint` fails it
 * (exit 3) with an ORG-CREATED-AT finding on that migration. A
 * `-- yodel:allow ORG-CREATED-AT <reason>` line above the step then
 * silences it, and lint passes.
 * BREAK: the check's rule is taken out, so the table without created_at
 * goes unreported.
 */
async function body(ctx: Ctx): Promise<void> {
  const p = await Project.create(ctx);
  p.write("policies/rules.ts", ctx.broken ? WEAKENED : POLICY);
  p.edit("chant.config.ts", 'lexicons: ["sql"],', 'lexicons: ["sql"],\n  lint: { policies: ["policies/rules.ts"] },');
  const id = await p.newMigration("create");
  if (id === undefined) throw new Error("yodel new wrote no migration");
  await p.commit("create, with a column rule");

  const ran = await p.yodel(["lint", "--json"]);
  const found = parse<LintDoc>(ran).findings.find((f) => f.rule === "ORG-CREATED-AT" && f.migration === id);
  hold(ran.code === 3 && found !== undefined, `yodel lint exited ${String(ran.code)} with no ORG-CREATED-AT finding on ${id}, whose orders table has no created_at`);

  // Silenced above the step on orders, the finding fails nothing.
  const sql = `migrations/${id}/migration.sql`;
  const object = found.object ?? "orders";
  const line = p.read(sql).split("\n").find((l) => l.startsWith("--") && l.includes(object));
  if (line === undefined) throw new Error(`${sql} has no comment naming ${object}`);
  p.edit(sql, line, `-- yodel:allow ORG-CREATED-AT orders predates the rule\n${line}`);
  const updated = await p.yodel(["lint", "--update-checksum", id]);
  if (updated.code !== 0) throw new Error(`yodel lint --update-checksum ${id} exited ${String(updated.code)}`);
  const allowed = await p.yodel(["lint", "--json"]);
  const silenced = parse<LintDoc>(allowed).findings.find((f) => f.rule === "ORG-CREATED-AT");
  hold(allowed.code === 0 && silenced?.silenced === "orders predates the rule", `with a yodel:allow line, yodel lint exited ${String(allowed.code)} and the finding is ${JSON.stringify(silenced)}`);
}

export const policyClaim: Claim = {
  name: "policy",
  says: "a project's own column rule from chant.config.ts lint.policies fails yodel lint on the migration that breaks it, and a yodel:allow line silences it",
  // The rule runs on the parsed schema; how lint loads and reports it is the same on both dialects.
  dialects: { pg: body },
};
