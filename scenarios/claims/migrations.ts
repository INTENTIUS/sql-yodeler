/**
 * Versioned migrations: yodel new, a hand-written migration (#248), yodel
 * lint and its replay, a project's own column rule, another tool's
 * migrations checked (#1), and a migration merged out of order. scenarios/lib/claim.ts {@link rollup} runs the
 * members in turn.
 */

import { rollup } from "../lib/claim.js";
import { checkClaim } from "./migrations/check.js";
import { lintClaim } from "./migrations/lint.js";
import { newClaim } from "./migrations/new.js";
import { outOfOrder } from "./migrations/out-of-order.js";
import { policyClaim } from "./migrations/policy.js";
import { sqlClaim } from "./migrations/sql.js";

export const migrations = rollup("migrations", [newClaim, sqlClaim, lintClaim, policyClaim, checkClaim, outOfOrder]);
