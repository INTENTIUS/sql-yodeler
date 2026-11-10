/**
 * #296: the cloud login through chant's ci-identity. yodel.config.ts
 * `ci.login` maps to chant's trade spec; the GitHub and GitLab login is
 * chant's one step and GitLab's id_tokens are chant's (yodel's own steps
 * there left in 0.12, #303); Forgejo, which gives a job no OIDC token, keeps
 * yodel's login from the runner's token file; a plan job's trade names only its readers'
 * identities and a wave job's the writer's. Rendering only: nothing here
 * trades a token or calls a cloud.
 */

import { forgejoCloudLogin } from "@intentius/chant/ci-login";
import { describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { gitlabTradeLines, tradeLine } from "@intentius/chant/ci-identity";
import { loginSteps, tradeIdTokens, tradeSpec, type Login, type TradeSpec } from "../src/ci/login.js";
import { gitlabPipeline, type Environments } from "../src/ci/render.js";
import { checkYodelConfig } from "../src/config/index.js";

const ROLE = "arn:aws:iam::123456789012:role/yodel";
const PROVIDER = "projects/123456789/locations/global/workloadIdentityPools/ci/providers/forge";
const SA = "yodel@shop-dev.iam.gserviceaccount.com";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const TENANT = "66666666-7777-8888-9999-000000000000";

const logins: Login[] = [
  { cloud: "aws", config: { roleArn: ROLE, region: "eu-west-1" } },
  { cloud: "gcp", config: { workloadIdentityProvider: PROVIDER, serviceAccount: SA } },
  { cloud: "azure", config: { clientId: CLIENT, tenantId: TENANT } },
];

describe("ci.login as chant's trade spec (#296)", () => {
  it("maps each cloud's login, with the database token for entra", () => {
    expect(tradeSpec(logins)).toEqual({
      aws: { role: ROLE, region: "eu-west-1", audience: "sts.amazonaws.com" },
      gcp: { serviceAccount: SA, provider: PROVIDER, audience: `https://iam.googleapis.com/${PROVIDER}` },
      azure: { clientId: CLIENT, tenantId: TENANT, audience: "api://AzureADTokenExchange", database: true },
    });
    expect(tradeSpec([{ cloud: "aws", config: { roleArn: ROLE } }]).aws?.region).toBe("us-east-1");
  });

  it("takes aws.region and refuses one that is not a region", () => {
    expect(checkYodelConfig({ ci: { login: { aws: { roleArn: ROLE, region: "eu-west-1" } } } }, "yodel.config.ts").ci?.login?.aws?.region).toBe("eu-west-1");
    expect(() => checkYodelConfig({ ci: { login: { aws: { roleArn: ROLE, region: "Europe" } } } }, "yodel.config.ts")).toThrow(/region/);
  });
});

describe("the login steps through chant's trade (#296)", () => {
  it("are chant's one step on GitHub, with the spec exported and the variables written to $GITHUB_ENV", () => {
    const steps = loginSteps("github", logins);
    expect(steps.steps).toHaveLength(1);
    expect(steps.steps[0]?.lines[0]).toBe(`export CHANT_CLOUD_TRADE='${JSON.stringify(tradeSpec(logins))}'`);
    expect(steps.steps[0]?.lines[1]).toBe(tradeLine("$GITHUB_ENV", "github-env"));
    expect(steps.steps.flatMap((s) => s.lines).join("\n")).not.toMatch(/\baws sts|gcloud|az login/);
  });

  it("are chant's trade lines on GitLab, with the spec as the job's variable and chant's id_tokens", () => {
    const steps = loginSteps("gitlab", logins);
    expect(steps.variables).toEqual({ CHANT_CLOUD_TRADE: JSON.stringify(tradeSpec(logins)) });
    expect(steps.steps[0]?.lines).toEqual(gitlabTradeLines());
    expect(Object.keys(tradeIdTokens(logins) ?? {})).toEqual(["CHANT_ID_TOKEN_AWS", "CHANT_ID_TOKEN_GCP", "CHANT_ID_TOKEN_AZURE"]);
  });

  it("are chant's cloud login on Forgejo, from the runner's token file, and none for a job with no login (chant issue 4788)", () => {
    const forgejo = loginSteps("forgejo", [{ cloud: "aws", config: { roleArn: ROLE, tokenFile: "/run/token" } }]);
    expect(forgejo.steps).toEqual(forgejoCloudLogin({ aws: { role: ROLE, tokenFile: "/run/token", sessionName: "yodel" } }).steps.map((st) => ({ name: st.name, lines: st.run })));
    expect(forgejo.steps[0]?.name).toBe("Cloud login (chant ci-login: aws)");
    expect(loginSteps("forgejo", logins).steps).toEqual([]);
    expect(loginSteps("github", [])).toEqual({ steps: [], variables: {} });
    expect(tradeIdTokens([])).toBeUndefined();
  });

  it("give a plan job only its readers' identities, and the wave job the writer's", () => {
    const envs: Environments = {
      dialect: "postgres",
      names: ["prod"],
      replay: false,
      waves: [{ env: "prod", gate: "always" }],
      credentials: { prod: { reader: { variables: [], cloud: "entra" }, writer: { variables: [], cloud: "rds-iam" } } },
      login: { aws: { roleArn: ROLE }, azure: { clientId: CLIENT, tenantId: TENANT } },
    };
    const doc = parseYAMLDocument(gitlabPipeline(envs).content) as Record<string, { variables?: Record<string, string>; id_tokens?: Record<string, unknown> }>;
    const plan = doc["plan-prod"];
    const spec = JSON.parse(plan?.variables?.CHANT_CLOUD_TRADE ?? "{}") as TradeSpec;
    expect(Object.keys(spec)).toEqual(["azure"]);
    expect(Object.keys(plan?.id_tokens ?? {})).toEqual(["CHANT_ID_TOKEN_AZURE"]);
  });

});
