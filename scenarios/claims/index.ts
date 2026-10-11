import type { Claim } from "../lib/claim.js";
import { approval } from "./approval.js";
import { clickhouse } from "./clickhouse.js";
import { declarative } from "./declarative.js";
import { forgejo } from "./forgejo.js";
import { github } from "./github.js";
import { gitlab } from "./gitlab.js";
import { migrations } from "./migrations.js";
import { resume } from "./resume.js";
import { wavesClaim } from "./waves.js";

/**
 * Every claim, in the order the summary and the record list them. Most are
 * rolled up from several (scenarios/lib/claim.ts rollup), each kept as
 * parts, so a full run is fewer runs.
 */
export const claims: readonly Claim[] = [migrations, declarative, approval, resume, clickhouse, wavesClaim, forgejo, github, gitlab];
