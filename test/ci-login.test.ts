/**
 * #132: yodel ci renders the cloud login a job runs before yodel, when a
 * role it holds has a cloud-minted password, from yodel.config.ts
 * `ci.login`, on each forge: chant's ci-identity trade on GitHub and GitLab
 * (#296), and on Forgejo, which gives a job no OIDC token, AWS web
 * identity, gcloud workload identity federation and az's federated token
 * from the runner's token file. Rendering only: nothing here runs a login
 * or calls a cloud.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { gitlabTradeLines, TRADE_SPEC_ENV } from "@intentius/chant/ci-identity";
import { forgejoLoginSpec, jobLogins, loginProblem, loginSteps, type Login } from "../src/ci/login.js";
import { repoRoot, yodel } from "./helpers/run.js";
import { CHANT } from "./helpers/chant-bin.js";

const ROLE = "arn:aws:iam::123456789012:role/yodel";
const PROD_ROLE = "arn:aws:iam::123456789012:role/yodel-prod";
const PROVIDER = "projects/123456789/locations/global/workloadIdentityPools/ci/providers/forge";
const SA = "yodel@shop-dev.iam.gserviceaccount.com";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const TENANT = "66666666-7777-8888-9999-000000000000";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/**
 * The Postgres template with cloud-minted roles: dev's reader by
 * cloud-sql-iam, prod's reader by entra and its writer by rds-iam; and
 * yodel.config.ts `ci.login` for each cloud, prod's AWS role its own.
 */
function project(login: string = `{ aws: { roleArn: "${ROLE}" }, gcp: { workloadIdentityProvider: "${PROVIDER}", serviceAccount: "${SA}" }, azure: { clientId: "${CLIENT}", tenantId: "${TENANT}" }, environments: { prod: { aws: { roleArn: "${PROD_ROLE}" } } } }`): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-ci-login-"));
  temps.push(dir);
  cpSync(join(repoRoot, "templates", "postgres"), dir, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const edit = (file: string, from: string | RegExp, to: string) => {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const next = text.replace(from, to);
    if (next === text) throw new Error(`${file}: nothing to replace for ${String(from)}`);
    writeFileSync(path, next);
  };
  edit("chant.config.ts", 'prod: postgres("prod", "postgres://db.example.com:5432/app")', 'prod: { ...postgres("prod", "postgres://db.example.com:5432/app"), ...credentials("prod", "postgres", { reader: { password: { token: "entra" } }, writer: { password: { token: "rds-iam" } } }) }');
  edit("chant.config.ts", 'dev: postgres("dev", "postgres://127.0.0.1:5432/postgres")', 'dev: { ...postgres("dev", "postgres://127.0.0.1:5432/postgres"), ...credentials("dev", "postgres", { reader: { password: { token: "cloud-sql-iam" } } }) }');
  edit("yodel.config.ts", /^( {2}ci: \{ forges: \[[^\]]*\])( \},)$/m, `$1, login: ${login}$2`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

type Step = { name?: string; run?: string };
type ActionsJob = { steps: Step[] };
type GitLabJob = { script?: string[]; variables?: Record<string, string>; id_tokens?: Record<string, { aud: string }> };

const yaml = (dir: string, f: string) => parseYAMLDocument(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
const actionsJob = (dir: string, f: string, job: string): ActionsJob => (yaml(dir, f).jobs as Record<string, ActionsJob>)[job] ?? { steps: [] };
const names = (job: ActionsJob) => job.steps.map((s) => s.name ?? s.run ?? "");
const step = (job: ActionsJob, name: string): string => job.steps.find((s) => s.name === name)?.run ?? "";

/** chant's trade step (#296), naming the clouds of the roles a job holds. test/ci-identity.test.ts covers its lines. */
const TRADED = (clouds: string) => `Cloud identity (chant ci-identity: ${clouds})`;

/** chant's cloud login (chant issue 4788), which logs a Forgejo job in from the runner's token file. */
const AZURE = "Cloud login (chant ci-login: azure)";
const LOGGED_IN = (n: string) => n.startsWith("Cloud login");

describe("yodel ci: the cloud login of a job holding a cloud-minted role", () => {
  it("GitHub and GitLab through chant's trade: one step per job, naming only the clouds of the roles it holds (#296)", async () => {
    const dir = project();
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const env = TRADE_SPEC_ENV;
    const traded = (job: ActionsJob) => names(job).filter((n) => n.startsWith("Cloud identity") || n.startsWith("Log in"));

    const prod = actionsJob(dir, ".github/workflows/yodel-pr.yml", "plan-prod");
    expect(traded(prod)).toEqual([TRADED("gcp, azure")]);
    expect(names(prod).indexOf(TRADED("gcp, azure"))).toBeLessThan(names(prod).indexOf("This job cannot write"));
    expect(step(prod, TRADED("gcp, azure"))).toContain(`export ${env}=`);
    expect(traded(actionsJob(dir, ".github/workflows/yodel-pr.yml", "plan-dev"))).toEqual([TRADED("gcp")]);
    const wave = actionsJob(dir, ".github/workflows/yodel-apply.yml", "wave-2-prod");
    // prod's writer is rds-iam, its plan runs as prod's entra reader (chant's sql-migrate plans without the writer),
    // and the wave reads dev's history with dev's cloud-sql-iam reader.
    expect(traded(wave)).toEqual([TRADED("aws, gcp, azure")]);
    expect(names(wave).indexOf(TRADED("aws, gcp, azure"))).toBeLessThan(names(wave).findIndex((n) => n.startsWith("Plan, gate and apply")));
    expect(step(wave, TRADED("aws, gcp, azure"))).toContain(PROD_ROLE);
    // dev's wave plans as dev's cloud-sql-iam reader.
    expect(traded(actionsJob(dir, ".github/workflows/yodel-apply.yml", "wave-1-dev"))).toEqual([TRADED("gcp")]);
    // The watch: each environment's reader, as chant's setup step (#4791), before chant run. A setup step has no name.
    const watch = actionsJob(dir, ".github/workflows/watch-prod.yml", "watch-prod");
    const setupTrade = (job: ActionsJob) => job.steps.filter((s) => s.name === undefined && s.run?.startsWith(`export ${env}=`));
    const setupClouds = (job: ActionsJob) => setupTrade(job).map((s) => Object.keys(JSON.parse(/^export \S+='([^']*)'/.exec(s.run ?? "")?.[1] ?? "{}") as object));
    expect(setupClouds(watch)).toEqual([["azure"]]);
    expect(watch.steps.findIndex((s) => s.name === undefined && s.run?.startsWith(`export ${env}=`))).toBeLessThan(names(watch).indexOf(`${CHANT} run watch-prod`));
    expect(setupClouds(actionsJob(dir, ".github/workflows/watch-dev.yml", "watch-dev"))).toEqual([["gcp"]]);

    const main = yaml(dir, ".gitlab-ci.yml") as Record<string, GitLabJob>;
    expect(main["plan-prod"]?.id_tokens).toEqual({ CHANT_ID_TOKEN_GCP: { aud: `https://iam.googleapis.com/${PROVIDER}` }, CHANT_ID_TOKEN_AZURE: { aud: "api://AzureADTokenExchange" } });
    expect(JSON.parse(main["plan-prod"]?.variables?.[env] ?? "{}")).toMatchObject({ gcp: { serviceAccount: SA }, azure: { clientId: CLIENT, tenantId: TENANT } });
    expect(main["plan-prod"]?.script?.slice(-2)).toEqual(["yodel config check prod dev --write-probe", "yodel plan prod --comment"]);
    const apply = yaml(dir, ".gitlab/yodel-apply.gitlab-ci.yml") as Record<string, GitLabJob>;
    expect(apply["wave-2-prod"]?.id_tokens?.CHANT_ID_TOKEN_AWS).toEqual({ aud: "sts.amazonaws.com" });
    expect(JSON.parse(apply["wave-2-prod"]?.variables?.[env] ?? "{}")).toMatchObject({ aws: { role: PROD_ROLE } });
    // dev's wave plans as dev's cloud-sql-iam reader, so it trades for gcp.
    expect(JSON.parse(apply["wave-1-dev"]?.variables?.[env] ?? "{}")).toHaveProperty("gcp");

    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
  });

  it("Forgejo: no OIDC token, so a login only from a token file the runner provides", async () => {
    const dir = project();
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    for (const [f, job] of [[".forgejo/workflows/yodel-pr.yml", "plan-prod"], [".forgejo/workflows/yodel-apply.yml", "wave-2-prod"], [".forgejo/workflows/watch-prod.yml", "watch-prod"]] as const) {
      expect(names(actionsJob(dir, f, job)).some(LOGGED_IN), `${f} ${job}`).toBe(false);
    }

    const given = project(`{ azure: { clientId: "${CLIENT}", tenantId: "${TENANT}", tokenFile: "/var/run/forge/azure-token" } }`);
    expect((await yodel(["ci", "--dir", given])).code).toBe(0);
    const prod = actionsJob(given, ".forgejo/workflows/yodel-pr.yml", "plan-prod");
    const az = step(prod, AZURE);
    // The spec names the token file, so the login reads it and requests no token.
    const spec = JSON.parse(/^export CHANT_CLOUD_LOGIN='([^']*)'/.exec(az)?.[1] ?? "{}") as Record<string, unknown>;
    expect(spec).toEqual({ azure: { clientId: CLIENT, tenantId: TENANT, tokenFile: "/var/run/forge/azure-token", cli: true, audience: "api://AzureADTokenExchange" } });
    expect(az).toContain('"$GITHUB_ENV" github-env forgejo');
    // No gcp login configured: dev's cloud-sql-iam reader gets none, here or on GitHub.
    expect(names(prod).filter(LOGGED_IN)).toEqual([AZURE]);
    expect(names(actionsJob(given, ".github/workflows/yodel-pr.yml", "plan-dev")).some((n) => LOGGED_IN(n) || n.startsWith("Cloud identity"))).toBe(false);
  });

  it("renders nothing for a job whose roles are not cloud-minted, and the templates do not change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-ci-login-plain-"));
    temps.push(dir);
    cpSync(join(repoRoot, "templates", "postgres"), dir, { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    // Render the template once without the login first: its committed files have chant's check hooks, and this copy keeps the declaration.
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    const config = join(dir, "yodel.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(/^( {2}ci: \{ forges: \[[^\]]*\])( \},)$/m, `$1, login: { aws: { roleArn: "${ROLE}" } }$2`));
    // The template's roles read variables: with a login configured, the files are the template's own.
    const check = await yodel(["ci", "--check", "--dir", dir]);
    expect(check.code, check.err).toBe(0);
  });

  it("refuses a login config it cannot render safely", async () => {
    for (const [login, message] of [
      ['{ aws: { roleArn: "my-role" } }', "ci.login.aws.roleArn: a role ARN"],
      [`{ aws: { roleArn: "${ROLE}", tokenFile: "$(curl evil)" } }`, "ci.login.aws.tokenFile: a file path"],
      [`{ gcp: { workloadIdentityProvider: "${PROVIDER}" } }`, "ci.login.gcp.serviceAccount"],
      ['{ azure: { clientId: "x", tenantId: "y" } }', "ci.login.azure.clientId"],
      ['{ oracle: {} }', "ci.login.oracle: unknown setting"],
      [`{ environments: { prod: { aws: { roleArn: "${ROLE}", zone: "x" } } } }`, "ci.login.environments.prod.aws.zone: unknown setting"],
      // ci.login.aws takes region since #296, and only an AWS region.
      [`{ environments: { prod: { aws: { roleArn: "${ROLE}", region: "x" } } } }`, "ci.login.environments.prod.aws.region: an AWS region"],
    ] as const) {
      const dir = project(login);
      const ran = await yodel(["ci", "--check", "--dir", dir]);
      expect(ran.code, login).not.toBe(0);
      expect(ran.err, login).toContain(message);
    }
    expect(loginProblem({ aws: { roleArn: ROLE, sessionName: "ci-run" } }, "ci.login")).toBeUndefined();
  });
});

describe("the login steps, per cloud and forge", () => {
  const aws: Login = { cloud: "aws", config: { roleArn: ROLE } };
  const gcp: Login = { cloud: "gcp", config: { workloadIdentityProvider: PROVIDER, serviceAccount: SA } };
  const azure: Login = { cloud: "azure", config: { clientId: CLIENT, tenantId: TENANT } };

  it("GitHub and GitLab trade through chant, Forgejo needs a token file", () => {
    for (const l of [aws, gcp, azure]) {
      const gh = loginSteps("github", [l]);
      expect(gh.steps).toHaveLength(1);
      expect(gh.steps[0]?.name).toBe(TRADED(l.cloud));
      expect(gh.steps[0]?.lines[0]).toMatch(new RegExp(`^export ${TRADE_SPEC_ENV}='\\{"${l.cloud}":`));
      expect(gh.variables).toEqual({});
      const gl = loginSteps("gitlab", [l]);
      expect(gl.steps[0]?.lines).toEqual(gitlabTradeLines());
      expect(Object.keys(gl.variables)).toEqual([TRADE_SPEC_ENV]);
      expect(loginSteps("forgejo", [l]).steps).toEqual([]);
    }
    // chant's login spec (chant issue 4788): the token file, yodel's session name, and the az command line for Azure.
    expect(forgejoLoginSpec([{ cloud: "aws", config: { roleArn: ROLE, tokenFile: "/run/t" } }])).toEqual({ aws: { role: ROLE, tokenFile: "/run/t", sessionName: "yodel" } });
    expect(forgejoLoginSpec([{ cloud: "aws", config: { roleArn: ROLE, tokenFile: "/run/t", sessionName: "ci-run", region: "eu-west-1" } }])).toEqual({ aws: { role: ROLE, tokenFile: "/run/t", sessionName: "ci-run", region: "eu-west-1" } });
    expect(forgejoLoginSpec([{ cloud: "gcp", config: { workloadIdentityProvider: PROVIDER, serviceAccount: SA, tokenFile: "/run/t" } }])).toEqual({ gcp: { serviceAccount: SA, provider: PROVIDER, tokenFile: "/run/t" } });
    expect(forgejoLoginSpec([{ cloud: "azure", config: { clientId: CLIENT, tenantId: TENANT, tokenFile: "/run/t" } }, aws])).toEqual({ azure: { clientId: CLIENT, tenantId: TENANT, tokenFile: "/run/t", cli: true } });
    const one = loginSteps("forgejo", [{ cloud: "aws", config: { roleArn: ROLE, tokenFile: "/run/t" } }, { cloud: "azure", config: { clientId: CLIENT, tenantId: TENANT, tokenFile: "/run/t" } }]);
    expect(one.steps.map((st) => st.name)).toEqual(["Cloud login (chant ci-login: aws, azure)"]);
    expect(one.steps[0]?.lines[0]).toMatch(/^export CHANT_CLOUD_LOGIN='/);
  });

  it("logs a job in once per cloud, and refuses two environments with different logins for one", () => {
    const cloudOf = (env: string) => (env === "dev" || env === "prod" ? "rds-iam" : undefined);
    const held = [["prod", "writer"], ["dev", "reader"]] as const;
    expect(jobLogins({ aws: { roleArn: ROLE } }, held, cloudOf)).toEqual([aws]);
    expect(jobLogins(undefined, held, cloudOf)).toEqual([]);
    expect(() => jobLogins({ aws: { roleArn: ROLE }, environments: { prod: { aws: { roleArn: PROD_ROLE } } } }, held, cloudOf)).toThrow(/a job holds prod's and dev's roles, which log in to aws differently/);
  });
});
