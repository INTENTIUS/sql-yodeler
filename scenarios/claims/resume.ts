/**
 * An apply that stops part way, or meets another: resume from receipts, a
 * Postgres column change as steps, and lock retry and serial applies.
 * scenarios/lib/claim.ts {@link rollup} runs the members in turn.
 */

import { rollup } from "../lib/claim.js";
import { columnChange } from "./resume/column-change.js";
import { lockRetry } from "./resume/lock-retry.js";
import { resume as resumeApply } from "./resume/resume.js";

export const resume = rollup("resume", [resumeApply, ["column", columnChange], ["lock", lockRetry]]);
