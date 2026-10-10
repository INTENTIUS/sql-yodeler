/**
 * The package root, for a project's `yodel.config.ts`:
 *
 * ```ts
 * import { defineConfig } from "@intentius/sql-yodeler";
 * export default defineConfig({ environments: { prod: { topology: "cluster:main" } } });
 * ```
 */

export { defineConfig } from "./config/define.js";
export { credentials, roleOf } from "./credentials.js";
export type { CloudToken, Credentials, EnvRef, ProfileCredentials, Role, RoleCredentials, TokenSource } from "./credentials.js";
export type { ApprovalMode, AwsLogin, AzureLogin, CiLogin, CloudLogins, EnvironmentApprovalMode, EnvironmentConfig, GcpLogin, PolicyConfig, PolicyMigration, PolicyPlan, PolicyRule, PolicyStep, NotifyConfig, Topology, TopologySetting, YodelConfig } from "./config/define.js";
export { verifyWebhook, signWebhook } from "./notify/verify.js";
export type { NotifyEvent, NotifyEventKind } from "./notify/index.js";
export type { DdlSource } from "./sources/index.js";
export { defineTests, expectError, expectRows, expectValue } from "./testing/define.js";
export type { ErrorExpectation, Expectation, RowsExpectation, TestCase, ValueExpectation } from "./testing/define.js";
