/**
 * The environments as stages of chant's pipeline (#384): one change going
 * dev, staging, prod, a soak that holds a promote, and the change risk
 * record. Its three parts, once written against the emulator:
 *
 * - stages: with ci.promotion [dev, staging, prod], the merge's wave applies
 *   dev and cuts a release (`yodel chant release cut`), and `yodel promote
 *   --to staging --release <label>`, then `--to prod`, apply the same
 *   migration there, each behind its stage gate. BREAK: the promote skips
 *   staging, and is refused.
 * - soak-hold: dev soaks with a command check that fails; the promote into
 *   staging exits 3 with the soak named, nothing applied there, and goes
 *   through once the check passes for the soak's duration. BREAK: the soak
 *   is left out of the rendered pipeline, so the promote goes through while
 *   the check fails.
 * - risk: a migration that drops a column, with ci.risk.approveAbove set,
 *   gets a risk record naming the sql lexicon's destructive class in
 *   `yodel plan --format markdown`, and dev's wave under gate `never` waits
 *   for an approval. BREAK: the risk keys are left out, so the drop applies
 *   unapproved.
 *
 * The record has no row for it yet: `docs/claims.md` shows it as not
 * recorded until a maintainer runs it.
 */

import type { Claim } from "../lib/claim.js";

export const pipeline: Claim = {
  name: "pipeline",
  says: "with ci.promotion, one change goes dev, staging, prod through chant's folded pipeline: the merge applies dev and cuts a release, and yodel promote takes it into staging and prod, each behind its stage gate; a failing soak check on a stage holds the promote into the stage after it; a migration that drops a column gets a change risk record naming the sql lexicon's destructive class, shown in the plan note, and over the stage's threshold its wave waits for an approval",
  dialects: { pg: { needs: "#384" } },
  parts: ["stages", "soak-hold", "risk"],
};
