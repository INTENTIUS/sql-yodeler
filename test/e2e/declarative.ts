/**
 * The declarative path end to end against the emulator, the same for each
 * dialect: plan, apply behind the plan-bound gate, drift, and a change that
 * needs its own Op. Each dialect supplies its fixture and its SQL.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import { json, yodel } from "../helpers/run.js";
import { e2eProject } from "./names.js";

export interface DialectHooks {
  dialect: "clickhouse" | "postgres";
  reachable: boolean;
  /** The database / schema the fixture declares (FIXTURE_NAME in it). */
  name: string;
  /** Drops it. */
  reset: () => Promise<void>;
  /** Whether the fixture's main table exists on the server. */
  tableExists: () => Promise<boolean>;
  /** How many objects the fixture declares. */
  declared: number;
  /** A source edit that adds a column in place. */
  addColumn: [from: string, to: string];
  /** A second edit, to the column {@link addColumn} added. */
  changeColumn: [from: string, to: string];
  /** A source edit the plan refuses: it needs a rebuild or expand-and-contract Op. */
  needsOp: [from: string, to: string];
  /** Creates an object the project does not declare. */
  foreign: () => Promise<void>;
  /** Changes a declared object out of band; returns the export and the property path drift should name. */
  changeOutOfBand: () => Promise<{ name: string; path: RegExp }>;
  /** Drops a declared object out of band; returns its export name. */
  dropOutOfBand: () => Promise<string>;
}

interface PlanDoc {
  environment: string;
  dialect: string;
  changes: Array<{ object: string; class: string }>;
  rebuilds?: unknown[];
  refused?: unknown[];
}

interface ApplyDoc {
  status: string;
  approve?: string;
  planDigest?: string;
}

interface DriftDoc {
  drifted: boolean;
  changed: Array<{ name: string; changes: Array<{ path: string }> }>;
  missing: string[];
}

export function declarativeSuite(h: DialectHooks): void {
  describe.skipIf(!h.reachable)(`the declarative path on ${h.dialect}`, () => {
    let dir = "";
    let dispose = (): void => {
      throw new Error("no project");
    };
    const at = (...args: string[]) => [...args, "--dir", dir];
    const edit = ([from, to]: [string, string]) => {
      const file = join(dir, "src", "schema.ts");
      const text = readFileSync(file, "utf8");
      if (!text.includes(from)) throw new Error(`fixture edit: ${JSON.stringify(from)} not in ${file}`);
      writeFileSync(file, text.replace(from, to));
    };
    const approve = async (command: string | undefined) => {
      expect(command).toMatch(/^chant approve /);
      const args = (command ?? "").split(" ").slice(1); // drop "chant"
      const ran = await runChant(args, { cwd: dir });
      expect(ran.code, ran.stderr).toBe(0);
    };

    beforeAll(async () => {
      await h.reset();
      ({ dir, dispose } = e2eProject(h.dialect, h.name));
    });
    afterAll(async () => {
      dispose();
      await h.reset();
    });

    it("plans the declared schema against an empty database", async () => {
      const ran = await yodel(at("plan", "e2e", "--json"));
      expect(ran.code, ran.err).toBe(0);
      const doc = (json(ran) as PlanDoc);
      expect(doc).toMatchObject({ environment: "e2e", dialect: h.dialect });
      expect(doc.changes.map((c) => c.class)).toEqual(Array(h.declared).fill("create"));

      const text = await yodel(at("plan", "e2e"));
      expect(text.code).toBe(0);
      // The header names the server it read (#11).
      expect(text.out).toMatch(new RegExp(`Plan for e2e \\(${h.dialect} [0-9.]+ at [^,]+, sql\\.profiles\\.e2e`));
      expect(text.out).toContain(`${String(h.declared)} create`);
    });

    it("applies only behind the ApplyOp's gate", async () => {
      const first = await yodel(at("apply", "e2e", "--json"));
      expect(first.code, first.err).toBe(3);
      const gated = (json(first) as ApplyDoc);
      expect(gated.status).toBe("gated");
      expect(gated.approve).toMatch(/^chant approve apply-e2e approve-apply-e2e --plan \S+$/);
      expect(await h.tableExists()).toBe(false);

      await approve(gated.approve);
      const second = await yodel(at("apply", "e2e", "--json"));
      expect(second.code, second.err).toBe(0);
      expect((json(second) as ApplyDoc).status).toBe("applied");
      expect(await h.tableExists()).toBe(true);
    });

    it("applies only the plan that was approved", async () => {
      edit(h.addColumn);
      const first = await yodel(at("apply", "e2e", "--json"));
      expect(first.code, first.err).toBe(3);
      const gated = (json(first) as ApplyDoc);

      // Approve what was shown, then change the source again: the approval does not carry over.
      await approve(gated.approve);
      edit(h.changeColumn);
      const second = await yodel(at("apply", "e2e", "--json"));
      expect(second.code, second.err).toBe(3);
      const regated = (json(second) as ApplyDoc);
      expect(regated.planDigest).toBeDefined();
      expect(regated.planDigest).not.toBe(gated.planDigest);
      expect(second.err).toContain("is approved, but not for this plan");

      await approve(regated.approve);
      const third = await yodel(at("apply", "e2e", "--json"));
      expect(third.code, third.err).toBe(0);
      expect((json(third) as ApplyDoc).status).toBe("applied");
    });

    it("plans no changes once applied, and apply has nothing to do", async () => {
      const ran = await yodel(at("plan", "e2e", "--json"));
      expect(ran.code, ran.err).toBe(0);
      expect((json(ran) as PlanDoc).changes).toEqual([]);

      const again = await yodel(at("apply", "e2e", "--json"));
      expect(again.code, again.err).toBe(0);
      expect((json(again) as ApplyDoc).status).toBe("unchanged");
    });

    it("reports no drift, and none for an object the project does not declare", async () => {
      const clean = await yodel(at("drift", "e2e"));
      expect(clean.code, clean.err).toBe(0);
      expect(clean.out).toContain("No drift");

      await h.foreign();
      const ran = await yodel(at("drift", "e2e", "--json"));
      expect(ran.code, ran.err).toBe(0);
      expect((json(ran) as DriftDoc)).toMatchObject({ drifted: false, changed: [], missing: [] });
    });

    it("reports a declared object changed out of band, and exits 2", async () => {
      const { name, path } = await h.changeOutOfBand();
      const ran = await yodel(at("drift", "e2e", "--json"));
      expect(ran.code, ran.err).toBe(2);
      const doc = (json(ran) as DriftDoc);
      expect(doc.drifted).toBe(true);
      const entry = doc.changed.find((c) => c.name === name);
      expect(entry?.changes.some((c) => path.test(c.path)), JSON.stringify(doc.changed)).toBe(true);
    });

    it("exits 2 on a change that needs its own Op, and apply refuses it without running the Op", async () => {
      edit(h.needsOp);
      const ran = await yodel(at("plan", "e2e", "--json"));
      expect(ran.code, ran.err).toBe(2);
      const doc = (json(ran) as PlanDoc);
      expect((doc.rebuilds ?? doc.refused ?? []).length).toBeGreaterThan(0);

      const text = await yodel(at("plan", "e2e"));
      expect(text.code).toBe(2);
      expect(text.out).toContain("Refused:");

      const applied = await yodel(at("apply", "e2e", "--json"));
      expect(applied.code, applied.err).toBe(2);
      expect((json(applied) as ApplyDoc).status).toBe("refused");
    });

    it("reports a declared object gone from the server, and exits 2", async () => {
      const name = await h.dropOutOfBand();
      const ran = await yodel(at("drift", "e2e", "--json"));
      expect(ran.code, ran.err).toBe(2);
      expect((json(ran) as DriftDoc).missing).toContain(name);

      const text = await yodel(at("drift", "e2e"));
      expect(text.code).toBe(2);
      expect(text.out).toContain(`Gone (declared, not on the server):`);
    });
  });
}
