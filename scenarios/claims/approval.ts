/**
 * The gate: approval bound to the plan digest, and the pull request comment
 * that names that digest. scenarios/lib/claim.ts {@link rollup} runs the
 * members in turn.
 */

import { rollup } from "../lib/claim.js";
import { approval as approvalGate } from "./approval/approval.js";
import { prComment } from "./approval/pr-comment.js";

export const approval = rollup("approval", [approvalGate, ["comment", prComment]]);
