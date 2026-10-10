import type { Claim } from "../lib/claim.js";
import { adopt } from "./adopt.js";
import { approval } from "./approval.js";
import { columnChange } from "./column-change.js";
import { declarative } from "./declarative.js";
import { drift } from "./drift.js";
import { lockRetry } from "./lock-retry.js";
import { newClaim } from "./new.js";
import { outOfOrder } from "./out-of-order.js";
import { lintClaim } from "./lint.js";
import { prComment } from "./pr-comment.js";
import { rebuild } from "./rebuild.js";
import { resume } from "./resume.js";
import { templateClaim } from "./template.js";
import { templateGithub } from "./template-github.js";
import { templateGitlab } from "./template-gitlab.js";
import { topology } from "./topology.js";
import { wavesClaim } from "./waves.js";

/** Every claim, in the order the summary and the record list them: #34's list, then the Postgres-only ones. */
export const claims: readonly Claim[] = [
  adopt,
  newClaim,
  lintClaim,
  prComment,
  approval,
  resume,
  outOfOrder,
  rebuild,
  drift,
  declarative,
  topology,
  templateClaim,
  templateGithub,
  templateGitlab,
  lockRetry,
  columnChange,
  wavesClaim,
];
