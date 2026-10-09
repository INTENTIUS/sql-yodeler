/**
 * The Forgejo client against a real Forgejo: posts one comment on a pull
 * request, then finds it by its marker and updates it. Gated, so CI skips it:
 *
 *   YODEL_E2E_FORGEJO_API=http://localhost:3300/api/v1
 *   YODEL_E2E_FORGEJO_REPO=<owner>/<repo>   a throwaway repository with an open PR
 *   YODEL_E2E_FORGEJO_PR=<n>
 *   YODEL_E2E_FORGEJO_TOKEN=<token>         write:issue on that repository
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commentClient, findComment, upsertComment } from "../../src/pr/comment.js";
import { resolveForgeTarget } from "../../src/pr/forge.js";

const api = process.env.YODEL_E2E_FORGEJO_API ?? "";

describe.skipIf(!api)("the plan comment on a real Forgejo", () => {
  it("creates the comment, then updates the same one", async () => {
    const target = resolveForgeTarget(
      { forge: "forgejo", repo: process.env.YODEL_E2E_FORGEJO_REPO, pr: process.env.YODEL_E2E_FORGEJO_PR, apiUrl: api, tokenEnv: "YODEL_E2E_FORGEJO_TOKEN" },
      process.env,
    );
    const client = commentClient(target);
    const marker = `<!-- yodel:plan env=e2e-${randomUUID()} -->`;
    const first = await upsertComment(client, marker, `${marker}\nfirst`);
    expect(first.action).toBe("created");
    const second = await upsertComment(client, marker, `${marker}\nsecond`);
    expect(second).toMatchObject({ action: "updated", comment: { id: first.comment.id } });
    const found = await findComment(client, marker);
    expect(found).toMatchObject({ id: first.comment.id, body: `${marker}\nsecond` });
    expect((await client.list()).filter((c) => c.body.includes(marker))).toHaveLength(1);
  });
});
