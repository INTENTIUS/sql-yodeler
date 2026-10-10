/**
 * The package root, for a project's `yodel.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "@intentius/sql-yodeler";
 * export default defineConfig({ environments: { prod: { topology: "cluster:main" } } });
 * ```
 */

export { defineConfig } from "./config/define.js";
export type { EnvironmentConfig, PolicyConfig, PolicyMigration, PolicyPlan, PolicyRule, PolicyStep, Topology, TopologySetting, YodelConfig } from "./config/define.js";
