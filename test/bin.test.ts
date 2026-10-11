import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { fixture, repoRoot } from "./helpers/run.js";

const bin = join(repoRoot, "dist", "bin.js");

// The built bin, as `npm run build` leaves it (CI builds before it tests).
describe.skipIf(!existsSync(bin))("the yodel bin", () => {
  it("loads chant's TypeScript and the project's chant.config.ts under its own tsx", async () => {
    // Plain node, no loader: the bin registers tsx itself.
    const ran = await promisify(execFile)(process.execPath, [bin, "plan", "prod", "--dir", fixture("postgres")]).catch(
      (e: unknown) => e as { code: number; stderr: string },
    );
    expect("code" in ran ? ran.code : 0).toBe(1);
    expect(ran.stderr).toMatch(/^yodel plan: no environment "prod".*declared: e2e/);
  });
});

// A receiver imports @intentius/sql-yodeler/webhook in plain node, with no loader (#211): it and chant's notify-verify are compiled JS.
describe.skipIf(!existsSync(join(repoRoot, "dist", "notify", "verify.js")))("the webhook export", () => {
  it("imports and verifies in plain node", async () => {
    const script = [
      'import { signWebhook, verifyWebhook } from "@intentius/sql-yodeler/webhook";',
      'const body = "{}";',
      'const headers = { "x-yodel-timestamp": "100", "x-yodel-signature": signWebhook("k", 100, body) };',
      "console.log(JSON.stringify(verifyWebhook({ body, headers, key: \"k\", now: 100 })));",
    ].join("\n");
    const ran = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: repoRoot });
    expect(JSON.parse(ran.stdout)).toEqual({ ok: true, event: {} });
  });
});
