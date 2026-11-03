/**
 * `yodel plan <env> --part <file>` (#237): the versioned plan as a chant
 * change-set part, which chant reads back with planner `sql`, composes with
 * other members' parts, and whose member digest is the one yodel apply's
 * gate binds.
 */

import { describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { composeChangeSet, readChangeSetPartFile } from "@intentius/chant/change-set";
import type { VersionedPlan } from "../src/pr/model.js";
import { planPart, slotPart } from "../src/pr/part.js";

const DIGEST = `jcs1-sha256:${"c".repeat(64)}`;

const statement = (name: string, sql: string, rule: string, cls: string, extra: Partial<MigrationStep> = {}): MigrationStep =>
  ({ kind: "statement", object: name.split(".")[1] ?? name, type: "ClickHouse::Table", name, sql, rule, class: cls, transactional: false, ...extra }) as MigrationStep;

const plan = (over: Partial<VersionedPlan> = {}): VersionedPlan => ({
  environment: "prod",
  dialect: "clickhouse",
  appliedCount: 1,
  pending: [
    {
      id: "20261012T1000-one",
      outOfOrder: false,
      steps: [
        { index: 0, step: statement("app.events", "ALTER TABLE app.events ADD COLUMN note String DEFAULT ''", "SQLCH201", "metadata"), done: true },
        { index: 1, step: statement("app.events", "ALTER TABLE app.events DROP COLUMN old", "SQLCH202", "metadata", { destructive: true }), done: false },
        { index: 2, step: { ...statement("app.loader", "CREATE USER loader IDENTIFIED WITH sha256_password BY 'x' SETTINGS PASSWORD = 'hunter2'", "SQLCH280", "create"), type: "ClickHouse::User" }, done: false },
      ],
    },
  ],
  problems: [],
  digest: DIGEST,
  notes: [],
  ...over,
});

describe("yodel plan --part (#237)", () => {
  it("writes one entry per object its pending steps touch, with yodel's plan digest", () => {
    const part = planPart(plan(), "db");
    expect(part.member).toMatchObject({ member: "db", planner: "sql", status: "planned", planDigest: DIGEST });
    const byAddress = Object.fromEntries(part.entries.map((e) => [e.address, e]));
    expect(Object.keys(byAddress).sort()).toEqual(["app.events", "app.loader"]);
    // The add already ran (done); the drop is what is left, destructive.
    expect(byAddress["app.events"]).toMatchObject({ action: "update", disruption: "destroy", scope: "prod" });
    expect(byAddress["app.loader"]).toMatchObject({ action: "create", type: "ClickHouse::User" });
  });

  it("redacts secrets in the statements it carries, as --json does", () => {
    const text = JSON.stringify(planPart(plan(), "db"));
    expect(text).not.toContain("hunter2");
    expect(text).toContain("PASSWORD = '[redacted]'");
  });

  it("reads back as chant's sql part from its JSON and composes with another member's", () => {
    const written = JSON.parse(JSON.stringify(planPart(plan(), "whatever-yodel-called-it"))) as unknown;
    const part = readChangeSetPartFile(written, "sql", "db");
    expect(part.member.member).toBe("db");
    expect(part.member.planDigest).toBe(DIGEST);
    const doc = composeChangeSet([part, { member: { member: "estate", planner: "terraform", lexicon: "aws", status: "planned", planDigest: `jcs1-sha256:${"e".repeat(64)}`, holes: [] }, entries: [] }]);
    expect(doc.members.map((m) => m.member)).toEqual(["db", "estate"]);
    expect(doc.entries.filter((e) => e.member === "db").map((e) => e.address)).toEqual(["app.events", "app.loader"]);
    expect(doc.summary.byMember.db).toMatchObject({ update: 1, create: 1 });
    expect(doc.summary.failed).toEqual([]);
  });

  it("makes a plan apply would refuse a failed member, with no digest", () => {
    const part = planPart(plan({ digest: undefined, refusal: { exitCode: 1, message: "20261012T0900-zero was applied with another checksum" } }), "db");
    expect(part.member.status).toBe("failed");
    expect(part.member.planDigest).toBeNull();
  });
});

describe("yodel plan <env>/@<i>of<n> --part: a slot of a tenant set read by a query (#56)", () => {
  const tenant = (name: string, over: Partial<VersionedPlan> = {}): VersionedPlan => plan({ environment: `prod/${name}`, digest: `jcs1-sha256:${name.padEnd(64, "0").slice(0, 64)}`, ...over });

  it("is one part for the slot, every tenant's entries scoped to the tenant, which chant's sql-migrate reads back as the run's", () => {
    const written = JSON.parse(JSON.stringify(slotPart("prod/@1of2", [tenant("acme"), tenant("globex")], "db"))) as unknown;
    const part = readChangeSetPartFile(written, "sql", "prod/@1of2", "sql");
    expect(part.member).toMatchObject({ member: "prod/@1of2", planner: "sql", status: "planned", scope: "prod/@1of2" });
    expect(part.member.planDigest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(part.entries.map((e) => `${e.scope ?? ""} ${e.address}`).sort()).toEqual(["prod/acme app.events", "prod/acme app.loader", "prod/globex app.events", "prod/globex app.loader"]);
  });

  it("digests over the tenants' plan digests, the same in any order, and moves when a tenant's plan does", () => {
    const a = tenant("acme");
    const b = tenant("globex");
    const digest = (ts: VersionedPlan[], slot = "prod/@1of2") => slotPart(slot, ts, "db").member.planDigest;
    expect(digest([a, b])).toBe(digest([b, a]));
    expect(digest([a, b])).not.toBe(digest([a, { ...b, digest: DIGEST }]));
    expect(digest([a, b])).not.toBe(digest([a, b], "prod/@2of2"));
    expect(digest([a])).not.toBe(digest([a, b]));
  });

  it("fails the slot, naming the tenant apply would refuse, with no digest", () => {
    const part = slotPart("prod/@1of2", [tenant("acme"), tenant("globex", { digest: undefined, refusal: { exitCode: 1, message: "20261012T0900-zero was applied with another checksum" } })], "db");
    expect(part.member.status).toBe("failed");
    expect(part.member.planDigest).toBeNull();
    expect(part.member.error).toContain("prod/globex: 20261012T0900-zero was applied with another checksum");
    expect(part.member.error).not.toContain("prod/acme");
  });

  it("plans a slot no tenant hashes to now as a planned member with nothing in it", () => {
    const part = readChangeSetPartFile(JSON.parse(JSON.stringify(slotPart("prod/@2of2", [], "db"))) as unknown, "sql", "prod/@2of2", "sql");
    expect(part.member.status).toBe("planned");
    expect(part.member.planDigest).toMatch(/^jcs1-sha256:/);
    expect(part.entries).toEqual([]);
  });
});
