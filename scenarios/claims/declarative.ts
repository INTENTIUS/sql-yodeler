/**
 * The declared schema against the live server: the declarative path, drift,
 * and adopting a live database. scenarios/lib/claim.ts {@link rollup} runs
 * the members in turn.
 */

import { rollup } from "../lib/claim.js";
import { adopt } from "./declarative/adopt.js";
import { declarative as declarativePath } from "./declarative/declarative.js";
import { drift } from "./declarative/drift.js";

export const declarative = rollup("declarative", [declarativePath, drift, adopt]);
