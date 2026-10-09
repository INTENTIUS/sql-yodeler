import { describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { commentMarker, COMMENT_LIMIT, planJsonVersioned, redact, renderPlanMarkdown, renderPlanText, subjectIn } from "../src/pr/render.js";
import type { VersionedPlan } from "../src/pr/model.js";
import { decodeSubject } from "../src/versioned/explain.js";

const DIGEST = `jcs1-sha256:${"c".repeat(64)}`;
const OLD = `jcs1-sha256:${"d".repeat(64)}`;

const chStatement = (sql: string, rule = "SQLCH201", cls = "metadata", extra: Partial<MigrationStep> = {}): MigrationStep =>
  ({ kind: "statement", object: "events", type: "ClickHouse::Table", name: "yodel_16.events", sql, rule, class: cls, transactional: false, ...extra }) as MigrationStep;

const rebuild: MigrationStep = {
  kind: "op",
  object: "events",
  type: "ClickHouse::Table",
  name: "yodel_16.events",
  op: "ClickHouseRebuildOp",
  importPath: "@intentius/chant-lexicon-sql/clickhouse",
  options: { name: "rebuild-events" },
  declaration: 'export const rebuild = ClickHouseRebuildOp({ name: "rebuild-events" });',
  changes: [{ rule: "SQLCH220", class: "rebuild", field: "orderBy", before: "(kind, ts)", after: "(ts, kind)" }],
  detail: "SQLCH220 orderBy: a rebuild; make it with ClickHouseRebuildOp",
};
const manual: MigrationStep = {
  kind: "manual",
  object: "v",
  type: "ClickHouse::View",
  name: "yodel_16.v",
  changes: [{ rule: "SQLCH240", class: "rebuild", field: "query" }],
  detail: "a view's query changes; drop and create it by hand",
};

const subject = { environment: "prod", historyDatabase: "yodeler", applied: [{ id: "20261009T0900-zero", checksum: "sha256:0" }], pending: [{ id: "20261009T1000-one", checksum: "sha256:1", done: [] }], live: "sha256:live" };

const clickhousePlan = (over: Partial<VersionedPlan> = {}): VersionedPlan => ({
  environment: "prod",
  dialect: "clickhouse",
  history: "yodeler.history (single)",
  appliedCount: 1,
  pending: [
    {
      id: "20261009T1000-one",
      outOfOrder: false,
      steps: [
        { index: 0, step: chStatement("ALTER TABLE yodel_16.events ADD COLUMN note String DEFAULT ''"), done: false },
        { index: 1, step: chStatement("ALTER TABLE yodel_16.events DROP COLUMN old", "SQLCH210", "drop", { destructive: true }), done: false },
        { index: 2, step: rebuild, done: false },
        { index: 3, step: manual, done: false, refused: "a manual step for v (yodel_16.v): no statement and no Op makes it" },
      ],
    },
  ],
  problems: ["20261009T0900-zero was applied with checksum sha256:a, but its files now hash to sha256:b"],
  digest: DIGEST,
  subject,
  approval: { kind: "op", op: "migrate-prod", gate: "approve-migrate-prod", command: `chant approve migrate-prod approve-migrate-prod --plan ${DIGEST}` },
  notes: [],
  ...over,
});

describe("the plan comment's markdown", () => {
  it("starts with the environment's marker and lists each statement with its rule and class", () => {
    const md = renderPlanMarkdown(clickhousePlan());
    expect(md.startsWith(`${commentMarker("prod")}\n`)).toBe(true);
    expect(commentMarker("prod")).toBe("<!-- yodel:plan env=prod -->");
    expect(md).toContain("| 0 | statement | SQLCH201 | metadata | `yodel_16.events` |");
    expect(md).toContain("| 1 | statement | SQLCH210 | drop, destructive | `yodel_16.events` |");
    expect(md).toContain("ALTER TABLE yodel_16.events ADD COLUMN note String DEFAULT '';");
    expect(md).toContain("**1 pending**");
  });

  it("names the Op that makes a refused change, with its detail and declaration, and a manual step's detail", () => {
    const md = renderPlanMarkdown(clickhousePlan());
    expect(md).toContain("| 2 | **Op ClickHouseRebuildOp** | SQLCH220 | rebuild | `yodel_16.events` |");
    expect(md).toContain("step 2, `yodel_16.events`: made by Op `ClickHouseRebuildOp` (SQLCH220 rebuild orderBy)");
    expect(md).toContain("SQLCH220 orderBy: a rebuild; make it with ClickHouseRebuildOp");
    expect(md).toContain('export const rebuild = ClickHouseRebuildOp({ name: "rebuild-events" });');
    expect(md).toContain("made by Op `ClickHouseRebuildOp` (SQLCH220 rebuild orderBy). yodel apply runs it as this step.");
    expect(md).toContain("step 3, `yodel_16.v`: manual, no Op makes it (SQLCH240 rebuild query). yodel apply refuses it.");
    expect(md).toContain("a view's query changes; drop and create it by hand");
  });

  it("lists integrity problems and apply's refusal", () => {
    const md = renderPlanMarkdown(clickhousePlan({ digest: undefined, refusal: { exitCode: 4, message: "refused: the history does not match" } }));
    expect(md).toContain("#### Integrity problems (1)");
    expect(md).toContain("- 20261009T0900-zero was applied with checksum sha256:a");
    expect(md).toContain("would refuse (exit 4)");
    expect(md).not.toContain("chant approve");
  });

  it("prints the digest the gate binds and the exact chant approve command, and carries the subject hidden", () => {
    const md = renderPlanMarkdown(clickhousePlan());
    expect(md).toContain(`Plan digest the apply gate binds: \`${DIGEST}\``);
    expect(md).toContain(`\`\`\`sh\nchant approve migrate-prod approve-migrate-prod --plan ${DIGEST}\n\`\`\``);
    expect(md).toContain("Not approved yet.");
    const carried = subjectIn(md);
    expect(carried && decodeSubject(carried)).toEqual(subject);
  });

  it("says when the newest approval is for another digest, and what moved", () => {
    const md = renderPlanMarkdown(
      clickhousePlan({
        approval: {
          kind: "op",
          op: "migrate-prod",
          gate: "approve-migrate-prod",
          command: `chant approve migrate-prod approve-migrate-prod --plan ${DIGEST}`,
          latest: { digest: OLD, by: "alice", at: "2026-10-09T12:00:00.000Z", holds: false, moved: { approved: OLD, now: DIGEST, confirmed: true, changes: [{ part: "pending", message: "new pending migration: 20261009T1000-one" }] } },
        },
      }),
    );
    expect(md).toContain(`is for \`${OLD}\`, not this plan; it does not hold.`);
    expect(md).toContain("What moved: pending migrations changed: new pending migration: 20261009T1000-one.");
  });

  it("says an approval for this digest holds", () => {
    const md = renderPlanMarkdown(clickhousePlan({ approval: { kind: "op", op: "migrate-prod", gate: "approve-migrate-prod", command: "x", latest: { digest: DIGEST, by: "bob", at: "t", holds: true } } }));
    expect(md).toContain("Approved by bob at t: the apply after merge runs this plan.");
  });

  it("renders a Postgres plan: statements with their classes, an expand-and-contract Op, no digest", () => {
    const pgOp: MigrationStep = { ...rebuild, type: "Postgres::Table", name: "app.orders", object: "orders", op: "PostgresMigrationOp", importPath: "@intentius/chant-lexicon-sql/postgres", changes: [{ rule: "SQLPG240", class: "rewrite", field: "columns.total" }], detail: "SQLPG240: a column type change rewrites the table; PostgresMigrationOp" };
    const plan: VersionedPlan = {
      environment: "staging",
      dialect: "postgres",
      appliedCount: 0,
      pending: [
        {
          id: "20261009T1000-orders",
          outOfOrder: false,
          steps: [
            { index: 0, step: { kind: "statement", object: "orders_idx", type: "Postgres::Index", name: "app.orders_idx", sql: "CREATE INDEX CONCURRENTLY orders_idx ON app.orders (id)", rule: "SQLPG110", class: "concurrently", transactional: false }, done: false },
            { index: 1, step: pgOp, done: false },
          ],
        },
      ],
      problems: [],
      notes: ["Postgres has no history table yet (#13): every migration is listed, and there is no digest to approve."],
    };
    const md = renderPlanMarkdown(plan);
    expect(md).toContain("<!-- yodel:plan env=staging -->");
    expect(md).toContain("Postgres: 0 applied");
    expect(md).toContain("| 0 | statement | SQLPG110 | concurrently | `app.orders_idx` |");
    expect(md).toContain("made by Op `PostgresMigrationOp` (SQLPG240 rewrite columns.total)");
    expect(md).toContain("> Postgres has no history table yet (#13)");
    expect(md).not.toContain("Plan digest");
    expect(subjectIn(md)).toBeUndefined();
  });

  it("drops the statements' SQL rather than go over the forge's limit", () => {
    const big = "x".repeat(COMMENT_LIMIT);
    const md = renderPlanMarkdown(clickhousePlan({ pending: [{ id: "20261009T1000-one", outOfOrder: false, steps: [{ index: 0, step: chStatement(`SELECT '${big}'`), done: false }] }] }));
    expect(md.length).toBeLessThan(COMMENT_LIMIT);
    expect(md).toContain("The statements are left out");
    expect(md).toContain(DIGEST);
  });

  it("redacts quoted passwords and keys in statements", () => {
    expect(redact("SOURCE(CLICKHOUSE(USER 'u' PASSWORD 'hunter2'))")).toBe("SOURCE(CLICKHOUSE(USER 'u' PASSWORD '[redacted]'))");
    expect(redact("s3('b', access_key_id = 'AKIA', secret_access_key = 's')")).toBe("s3('b', access_key_id = '[redacted]', secret_access_key = '[redacted]')");
    expect(renderPlanMarkdown(clickhousePlan({ pending: [{ id: "a", outOfOrder: false, steps: [{ index: 0, step: chStatement("CREATE DICTIONARY d SOURCE(CLICKHOUSE(PASSWORD 'hunter2'))"), done: false }] }] }))).not.toContain("hunter2");
  });
});

describe("the plan as text and JSON", () => {
  it("text lists steps with rule and class, the Op, problems, the digest and the approve command", () => {
    const text = renderPlanText(clickhousePlan());
    expect(text).toContain("Plan for prod (clickhouse, history yodeler.history (single)): 1 applied, 1 pending");
    expect(text).toContain("  0  statement  SQLCH201 metadata  yodel_16.events");
    expect(text).toContain("  2  Op ClickHouseRebuildOp  SQLCH220 rebuild  yodel_16.events");
    expect(text).toContain("  3  manual  SQLCH240 rebuild  yodel_16.v");
    expect(text).toContain("yodel apply refuses it: a manual step for v (yodel_16.v)");
    expect(text).toContain("yodel apply runs it as this step");
    expect(text).toContain("Integrity problems (1):");
    expect(text).toContain(`Plan digest: ${DIGEST}`);
    expect(text).toContain(`  chant approve migrate-prod approve-migrate-prod --plan ${DIGEST}`);
  });

  it("JSON carries the digest, the approve command and each step's rule, class or Op", () => {
    const doc = planJsonVersioned(clickhousePlan()) as { planDigest: string; approve: string; pending: Array<{ steps: Array<Record<string, unknown>> }> };
    expect(doc.planDigest).toBe(DIGEST);
    expect(doc.approve).toBe(`chant approve migrate-prod approve-migrate-prod --plan ${DIGEST}`);
    expect(doc.pending[0]?.steps.map((s) => [s.kind, s.rule ?? s.op])).toEqual([["statement", "SQLCH201"], ["statement", "SQLCH210"], ["op", "ClickHouseRebuildOp"], ["manual", undefined]]);
  });
});
