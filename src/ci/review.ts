/**
 * The review agent (#304): yodel.config.ts `review`, chant's `reviewAgent`
 * for `yodel ci`. The code that runs the model, splits the jobs and posts the
 * note is chant's (`@intentius/chant/op` `reviewAgent`, and the forge
 * lexicons' review jobs, chant#4326 and chant#4544). What yodel holds is
 * what belongs to SQL teams: the config key, the SQL rules for the prompt,
 * and the one line that hands the model the migrations the pull request adds.
 *
 * With `review` set, `yodel ci` writes:
 *
 *   ops/yodel-review.op.ts   a pull request Op: `yodel plan --pull-request
 *                            --change-set .chant/pr/change-set.json`, the
 *                            added migrations read from the files with no
 *                            server, then chant's reviewAgent in handoff
 *                            mode over that change set
 *   .chant/yodel-review.md   the instructions the model reads, from the
 *                            base branch: yodel's SQL rules for the
 *                            project's dialect, then `review.rules`
 *   the review pipeline      chant's generateOpsPipeline with the Op's spec
 *                            `reviewAgent: true` (../ci/render.ts
 *                            reviewPipelines): the review job, with no forge
 *                            write token and no database credential, and the
 *                            note job, which posts one note per pull request
 *                            and edits it on each push. On GitLab the note
 *                            job runs from a pipeline of the default branch
 *                            (chant#4544).
 *
 * The rules name what the plan note already shows a reviewer: each step's
 * class (destructive drops, the statements that take a lock, the ones that
 * rewrite or rebuild a table) as `yodel new` recorded it in migration.sql
 * and migration.json. Nothing in the change set says how large a table is,
 * so the rules have the model ask.
 */

import type { ReviewConfig, YodelConfig } from "../config/define.js";
import type { Dialect } from "./render.js";

/** The Op the review runs as. It keys the note's marker, `<!-- chant-review:yodel-review -->`. */
export const REVIEW_OP = "yodel-review";
export const REVIEW_OP_FILE = `ops/${REVIEW_OP}.op.ts`;
/** The instructions the model reads, at the base branch. */
export const REVIEW_INSTRUCTIONS = ".chant/yodel-review.md";
/** Where the review job's plan writes the change set the model reads. */
export const REVIEW_CHANGE_SET = ".chant/pr/change-set.json";
/** The GitLab file of the review jobs, included from .gitlab-ci.yml. */
export const GITLAB_REVIEW_FILE = ".gitlab/yodel-review.gitlab-ci.yml";
/** chant's default for the model's key (`REVIEW_KEY_ENV` in chant's review-agent.ts). */
export const DEFAULT_KEY_ENV = "ANTHROPIC_API_KEY";

/** The step's line before the model: the migrations the pull request adds, as a change set, read with no server. */
export const REVIEW_PLAN_LINE = `yodel plan --pull-request --change-set ${REVIEW_CHANGE_SET}`;

/** `review` as the Op's step takes it; undefined when the review is off. */
export interface ReviewSettings {
  command?: string;
  keyEnv: string;
  timeout?: number;
  rules: string[];
}

/** yodel.config.ts `review`, with chant's defaults where it sets none; undefined when it is off. */
export function reviewOf(config: Pick<YodelConfig, "review"> | undefined): ReviewSettings | undefined {
  const r = config?.review;
  if (r === undefined || r === false) return undefined;
  const m: ReviewConfig = r === true ? {} : r;
  return {
    ...(m.command !== undefined ? { command: m.command } : {}),
    keyEnv: m.keyEnv ?? DEFAULT_KEY_ENV,
    ...(m.timeout !== undefined ? { timeout: m.timeout } : {}),
    rules: m.rules ?? [],
  };
}

const FILE_HEADER = "Rendered by yodel ci from yodel.config.ts review. Edit that and render again; yodel ci --check says when this file is stale.";

/** ops/yodel-review.op.ts: the added migrations as a change set, then chant's reviewAgent in handoff mode. */
export function reviewOpFile(r: ReviewSettings): string {
  const step: Record<string, unknown> = {
    op: REVIEW_OP,
    changeSetFile: REVIEW_CHANGE_SET,
    mode: "handoff",
    instructions: REVIEW_INSTRUCTIONS,
    ...(r.command !== undefined ? { command: r.command } : {}),
    keyEnv: r.keyEnv,
    ...(r.timeout !== undefined ? { timeout: r.timeout } : {}),
  };
  const fields = Object.entries(step).map(([k, v]) => `      ${k}: ${JSON.stringify(v)},`);
  return [
    `// ${FILE_HEADER}`,
    "// A model reads the migrations the pull request adds and posts one note. It approves nothing and gates nothing.",
    `import { Op, phase, reviewAgent, shell } from "@intentius/chant/op";`,
    "",
    "export default Op({",
    `  name: ${JSON.stringify(REVIEW_OP)},`,
    `  overview: "A model reviews the migrations the pull request adds",`,
    "  phases: [",
    `    phase("Plan", [shell(${JSON.stringify(REVIEW_PLAN_LINE)})]),`,
    "    phase(\"Review\", [",
    "      reviewAgent({",
    ...fields.map((f) => `  ${f}`),
    "      }),",
    "    ]),",
    "  ],",
    "});",
    "",
  ].join("\n");
}

/** The rules every dialect shares. */
const COMMON_RULES = [
  "A `drop` class, or a step with `destructive: true` (a dropped column), loses data that no later migration brings back. Name the table or column. A drop the title and description do not mention is `risk: high`, and so is one they mention without saying the data is no longer read or is kept elsewhere.",
  "A step that a migration Op makes (`kind: \"op\"`) or a person makes (`kind: \"manual\"`) is not run by `yodel apply` as a statement; say what the Op or the person has to do, and what happens to the table while it runs.",
  "Nothing in the change set or the diff says how many rows a table holds. For each statement that rewrites, scans or rebuilds a table, ask the author how large the table is, unless the description says, and say what reads and writes of it do while the statement runs. A rewrite or rebuild of a table the description calls large, or of a table you cannot tell is small, is at least `risk: medium`.",
  "A `create` class makes an object that was not there; nothing existing changes. `metadata` changes only the catalog.",
  "Check that the migration's steps do what the title and description say: a column, index or table the description names and no step touches, or a step on an object the description does not name, is a mismatch.",
];

const DIALECT_RULES: Record<Dialect, string[]> = {
  postgres: [
    "`rewrite` rewrites or reads the whole table under ACCESS EXCLUSIVE: every read and write of the table waits until it ends, so on a large table it is an outage of that table for as long as it runs (a column with a volatile default, a STORED generated column or its expression, a type change that is not binary-coercible, a collation change).",
    "Most ALTER TABLE statements take ACCESS EXCLUSIVE, `metadata` ones too, if only briefly: while it waits behind a long query on the table, the queries after it wait too. Say so when a migration alters a table the description calls busy.",
    "`validate` reads every row under SHARE UPDATE EXCLUSIVE, so reads and writes go on, but it can fail on rows already there; the migration's pre-check counts them. A foreign key's NOT VALID step takes SHARE ROW EXCLUSIVE on both tables, briefly.",
    "`concurrently` builds an index with CREATE INDEX CONCURRENTLY, outside a transaction: writes go on, it takes longer, and a build that fails leaves an invalid index behind. A plain CREATE INDEX on an existing table blocks its writes for the whole build.",
    "`expand` is an expand-and-contract change (a rename or a type change across kinds, PostgresMigrationOp): readers that use the old name or type break unless they move first. Ask which readers there are.",
  ],
  clickhouse: [
    "`rewrite` is a mutation: the server rewrites the column in every part in the background, with no rollback, using disk and I/O for as long as it runs; on a large table that is hours. A TTL change recalculated over existing data is one too.",
    "`rebuild` and `replace` build the table again (ClickHouseRebuildOp): a new table, the rows copied into it, and a swap. On a large table the copy takes time and the space of a second copy, and a materialized view whose target is rebuilt does not see inserts made in between.",
    "`metadata` changes only the table's metadata; a new column, index or projection covers parts written after it until it is materialized, which is a mutation of its own.",
  ],
};

/** .chant/yodel-review.md: yodel's SQL rules for `dialect`, then the team's. */
export function reviewInstructions(dialect: Dialect, r: ReviewSettings): string {
  const list = (rules: readonly string[]) => rules.map((rule) => `- ${rule}`);
  return [
    `<!-- ${FILE_HEADER} -->`,
    "",
    `# Reviewing a SQL Yodeler pull request (${dialect === "postgres" ? "Postgres" : "ClickHouse"})`,
    "",
    "The change set holds the migrations this pull request adds, one entry per object they change: `delete` for a drop, `replace` for an object built again, `update` with its disruption for the rest. The diff carries each migration's `migration.sql`, where every statement follows a comment naming its object, its classifier rule and its class (such as `-- orders (shop.orders): SQLPG207 rewrite`), and its `migration.json`, whose steps record the same rule and class.",
    "",
    "Read the classes like this:",
    "",
    ...list([...COMMON_RULES.slice(0, 1), ...DIALECT_RULES[dialect], ...COMMON_RULES.slice(1)]),
    ...(r.rules.length > 0 ? ["", "## The team's rules", "", ...list(r.rules)] : []),
    "",
  ].join("\n");
}
