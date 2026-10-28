/**
 * The plan comment through chant's Forgejo client against a real Forgejo:
 * posts one comment on a pull request, then finds it by its marker and
 * updates it. Gated, so CI skips it:
 *
 *   YODEL_E2E_FORGEJO_API=http://localhost:3391/api/v1   (the e2e harness's Forgejo)
 *   YODEL_E2E_FORGEJO_REPO=<owner>/<repo>   a throwaway repository with an open PR
 *   YODEL_E2E_FORGEJO_PR=<n>
 *   YODEL_E2E_FORGEJO_TOKEN=<token>         write:issue on that repository
 *
 * Retired on a chant with the e2e harness (./harness-fallback.ts): the
 * harness scenarios' plan comments are the source then, and this runs only
 * on a chant without it.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveForge } from "../../src/pr/forge.js";
import { harnessCovers } from "./harness-fallback.js";

const api = process.env.YODEL_E2E_FORGEJO_API ?? "";

describe.skipIf(!api || harnessCovers)("the plan comment on a real Forgejo", () => {
  it("creates the comment, then updates the same one", async () => {
    const { client, target } = await resolveForge(
      { forge: "forgejo", repo: process.env.YODEL_E2E_FORGEJO_REPO, pr: process.env.YODEL_E2E_FORGEJO_PR, apiUrl: api, tokenEnv: "YODEL_E2E_FORGEJO_TOKEN" },
      process.env,
      "--comment",
    );
    const pr = target.pr ?? 0;
    const marker = `<!-- yodel:plan env=e2e-${randomUUID()} -->`;
    const first = await client.upsertComment(pr, marker, `${marker}\nfirst`);
    expect(first.action).toBe("created");
    const second = await client.upsertComment(pr, marker, `${marker}\nsecond`);
    expect(second).toMatchObject({ action: "updated", id: first.id });
    expect(await client.findComment(pr, marker)).toMatchObject({ id: first.id, body: `${marker}\nsecond` });
  });
});
