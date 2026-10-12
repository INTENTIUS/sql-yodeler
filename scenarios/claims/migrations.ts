/**
 * Versioned migrations: yodel new, yodel lint and its replay, a project's
 * own column rule, and a migration merged out of order. scenarios/lib/claim.ts {@link rollup} runs
 * the members in turn.
 */

import { rollup } from "../lib/claim.js";
import { lintClaim } from "./migrations/lint.js";
import { newClaim } from "./migrations/new.js";
import { outOfOrder } from "./migrations/out-of-order.js";
import { policyClaim } from "./migrations/policy.js";

export const migrations = rollup("migrations", [newClaim, lintClaim, policyClaim, outOfOrder]);
