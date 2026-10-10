import type { Claim } from "../lib/claim.js";
import { adopt } from "./adopt.js";
import { approveAndApply } from "./approve-and-apply.js";
import { backfillResumed } from "./backfill-resumed.js";
import { columnChange } from "./column-change.js";
import { declarative } from "./declarative.js";
import { digestMoved } from "./digest-moved.js";
import { drift } from "./drift.js";
import { lockRetry } from "./lock-retry.js";
import { newClaim } from "./new.js";
import { outOfOrder } from "./out-of-order.js";
import { lintCiClaim, replayClaim } from "./lint.js";
import { prComment } from "./pr-comment.js";
import { rebuildAsStep, rebuildRefused } from "./rebuild.js";
import { resume } from "./resume.js";
import { templateClaim } from "./template.js";
import { templateGithub } from "./template-github.js";
import { templateGitlab } from "./template-gitlab.js";
import { topology } from "./topology.js";

/** Every claim, in the order the summary and the record list them: #34's list, then the Postgres-only ones. */
export const claims: readonly Claim[] = [
  adopt,
  newClaim,
  lintCiClaim,
  prComment,
  approveAndApply,
  digestMoved,
  resume,
  outOfOrder,
  rebuildRefused,
  rebuildAsStep,
  backfillResumed,
  drift,
  declarative,
  replayClaim,
  topology,
  templateClaim,
  templateGithub,
  templateGitlab,
  lockRetry,
  columnChange,
];
