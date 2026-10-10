/**
 * #132: yodel ci renders the cloud login a job runs before yodel, when a
 * role it holds has a cloud-minted password: AWS web identity, gcloud
 * workload identity federation and az's federated token, from
 * yodel.config.ts `ci.login`, on each forge. Rendering only: nothing here
 * runs a login or calls a cloud.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { jobLogins, loginProblem, loginSteps, type Login } from "../src/ci/login.js";
import { repoRoot, yodel } from "./helpers/run.js";

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

const AWS = "Log in to AWS (web identity)";
const GCP = "Log in to Google Cloud (workload identity)";
const AZURE = "Log in to Azure (federated token)";

describe("yodel ci: the cloud login of a job holding a cloud-minted role", () => {
  it("GitHub: the OIDC token for the cloud's audience, the login, and its variables for the later steps", async () => {
    const dir = project();
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);

    // The pull request: prod's reader is entra, dev's cloud-sql-iam; each logs in before the write probe.
    const prod = actionsJob(dir, ".github/workflows/yodel-pr.yml", "plan-prod");
    expect(names(prod).indexOf(AZURE)).toBeLessThan(names(prod).indexOf("This job cannot write"));
    // plan-prod also reads dev (prod's wave requires it): dev's reader is cloud-sql-iam.
    expect(names(prod).filter((n) => n.startsWith("Log in"))).toEqual([GCP, AZURE]);
    const az = step(prod, AZURE);
    expect(az).toContain(`'api://AzureADTokenExchange' "$RUNNER_TEMP/yodel-azure-token"`);
    expect(az).toContain(`az login --service-principal --username '${CLIENT}' --tenant '${TENANT}' --federated-token "$(cat "$RUNNER_TEMP/yodel-azure-token")" --allow-no-subscriptions --output none`);
    expect(az).toContain(`echo "AZURE_CLIENT_ID=${CLIENT}" >> "$GITHUB_ENV"`);
    expect(az).toContain('echo "AZURE_FEDERATED_TOKEN_FILE=$RUNNER_TEMP/yodel-azure-token" >> "$GITHUB_ENV"');
    expect(az).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");

    const dev = actionsJob(dir, ".github/workflows/yodel-pr.yml", "plan-dev");
    expect(names(dev).filter((n) => n.startsWith("Log in"))).toEqual([GCP]);
    const gcp = step(dev, GCP);
    expect(gcp).toContain(`'https://iam.googleapis.com/${PROVIDER}' "$RUNNER_TEMP/yodel-gcp-token"`);
    expect(gcp).toContain(`'${PROVIDER}' '${SA}' "$RUNNER_TEMP/yodel-gcp-token" "$RUNNER_TEMP/yodel-gcp-token.json"`);
    expect(gcp).toContain('gcloud auth login --cred-file="$RUNNER_TEMP/yodel-gcp-token.json" --quiet');
    expect(gcp).toContain('echo "GOOGLE_APPLICATION_CREDENTIALS=$RUNNER_TEMP/yodel-gcp-token.json" >> "$GITHUB_ENV"');

    // The apply: prod's writer is rds-iam, with prod's own role, before the wave's chant run; dev's wave holds no cloud role.
    const wave = actionsJob(dir, ".github/workflows/yodel-apply.yml", "wave-2-prod");
    const run = names(wave).findIndex((n) => n.startsWith("Plan, gate and apply"));
    expect(names(wave).indexOf(AWS)).toBeGreaterThan(-1);
    expect(names(wave).indexOf(AWS)).toBeLessThan(run);
    const aws = step(wave, AWS);
    expect(aws).toContain(`'sts.amazonaws.com' "$RUNNER_TEMP/yodel-aws-token"`);
    expect(aws).toContain(`echo "AWS_ROLE_ARN=${PROD_ROLE}" >> "$GITHUB_ENV"`);
    expect(aws).toContain('echo "AWS_WEB_IDENTITY_TOKEN_FILE=$RUNNER_TEMP/yodel-aws-token" >> "$GITHUB_ENV"');
    expect(aws).toContain('echo "AWS_ROLE_SESSION_NAME=yodel" >> "$GITHUB_ENV"');
    expect(names(actionsJob(dir, ".github/workflows/yodel-apply.yml", "wave-1-dev")).some((n) => n.startsWith("Log in"))).toBe(false);

    // The watch: each environment's reader, before chant run.
    const watch = actionsJob(dir, ".github/workflows/watch-prod.yml", "watch-prod");
    expect(names(watch).indexOf(AZURE)).toBeGreaterThan(-1);
    expect(names(watch).indexOf(AZURE)).toBeLessThan(names(watch).indexOf("chant run watch-prod"));
    expect(names(actionsJob(dir, ".github/workflows/watch-dev.yml", "watch-dev"))).toContain(GCP);

    // Rendered again, nothing moves.
    const check = await yodel(["ci", "--check", "--dir", dir]);
    expect(check.code, check.err).toBe(0);
  });

  it("GitLab: the ID token for the login's audience, written to the token file, and the variables on the job", async () => {
    const dir = project();
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    const main = yaml(dir, ".gitlab-ci.yml") as Record<string, GitLabJob>;
    const prod = main["plan-prod"] ?? {};
    expect(prod.id_tokens).toEqual({ GCP_ID_TOKEN: { aud: `https://iam.googleapis.com/${PROVIDER}` }, AZURE_ID_TOKEN: { aud: "api://AzureADTokenExchange" } });
    expect(prod.script).toEqual([
      `(umask 077 && printf '%s' "$GCP_ID_TOKEN" > "/tmp/yodel-gcp-token")`,
      expect.stringContaining(`'${PROVIDER}' '${SA}' "/tmp/yodel-gcp-token" "/tmp/yodel-gcp-token.json"`),
      'gcloud auth login --cred-file="/tmp/yodel-gcp-token.json" --quiet',
      `(umask 077 && printf '%s' "$AZURE_ID_TOKEN" > "/tmp/yodel-azure-token")`,
      `az login --service-principal --username '${CLIENT}' --tenant '${TENANT}' --federated-token "$(cat "/tmp/yodel-azure-token")" --allow-no-subscriptions --output none`,
      "yodel config check prod dev --write-probe",
      "yodel plan prod --comment",
    ]);
    expect(prod.variables).toEqual({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/yodel-gcp-token.json", AZURE_CLIENT_ID: CLIENT, AZURE_TENANT_ID: TENANT, AZURE_FEDERATED_TOKEN_FILE: "/tmp/yodel-azure-token" });

    const apply = yaml(dir, ".gitlab/yodel-apply.gitlab-ci.yml") as Record<string, GitLabJob>;
    const wave = apply["wave-2-prod"] ?? {};
    expect(wave.id_tokens?.AWS_ID_TOKEN).toEqual({ aud: "sts.amazonaws.com" });
    expect(wave.variables).toMatchObject({ YODEL_CREDENTIALS: "writer:prod", AWS_ROLE_ARN: PROD_ROLE, AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/yodel-aws-token", AWS_ROLE_SESSION_NAME: "yodel" });
    const script = wave.script ?? [];
    const awsAt = script.indexOf(`(umask 077 && printf '%s' "$AWS_ID_TOKEN" > "/tmp/yodel-aws-token")`);
    expect(awsAt).toBeGreaterThan(-1);
    expect(awsAt).toBeLessThan(script.findIndex((l) => l.startsWith("chant run wave")));
    expect(apply["wave-1-dev"]?.variables).not.toHaveProperty("AWS_ROLE_ARN");

    const watch = yaml(dir, ".gitlab/yodel-watch.gitlab-ci.yml") as Record<string, GitLabJob>;
    const ws = watch["watch-prod"]?.script ?? [];
    expect(ws.findIndex((l) => l.startsWith("az login"))).toBeLessThan(ws.indexOf("chant run watch-prod"));
    expect(watch["watch-prod"]?.variables).toMatchObject({ AZURE_CLIENT_ID: CLIENT });
    expect(watch["watch-dev"]?.id_tokens).toEqual({ GCP_ID_TOKEN: { aud: `https://iam.googleapis.com/${PROVIDER}` } });

    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
  });

  it("Forgejo: no OIDC token, so a login only from a token file the runner provides", async () => {
    const dir = project();
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    for (const [f, job] of [[".forgejo/workflows/yodel-pr.yml", "plan-prod"], [".forgejo/workflows/yodel-apply.yml", "wave-2-prod"], [".forgejo/workflows/watch-prod.yml", "watch-prod"]] as const) {
      expect(names(actionsJob(dir, f, job)).some((n) => n.startsWith("Log in")), `${f} ${job}`).toBe(false);
    }

    const given = project(`{ azure: { clientId: "${CLIENT}", tenantId: "${TENANT}", tokenFile: "/var/run/forge/azure-token" } }`);
    expect((await yodel(["ci", "--dir", given])).code).toBe(0);
    const prod = actionsJob(given, ".forgejo/workflows/yodel-pr.yml", "plan-prod");
    const az = step(prod, AZURE);
    expect(az).not.toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(az.split("\n")[0]).toBe(`az login --service-principal --username '${CLIENT}' --tenant '${TENANT}' --federated-token "$(cat "/var/run/forge/azure-token")" --allow-no-subscriptions --output none`);
    expect(az).toContain('echo "AZURE_FEDERATED_TOKEN_FILE=/var/run/forge/azure-token" >> "$GITHUB_ENV"');
    // No gcp login configured: dev's cloud-sql-iam reader gets none, here or on GitHub.
    expect(names(prod).filter((n) => n.startsWith("Log in"))).toEqual([AZURE]);
    expect(names(actionsJob(given, ".github/workflows/yodel-pr.yml", "plan-dev")).some((n) => n.startsWith("Log in"))).toBe(false);
    // GitHub writes the token where the config says.
    expect(step(actionsJob(given, ".github/workflows/yodel-pr.yml", "plan-prod"), AZURE)).toContain(`'api://AzureADTokenExchange' "/var/run/forge/azure-token"`);
  });

  it("renders nothing for a job whose roles are not cloud-minted, and the templates do not change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-ci-login-plain-"));
    temps.push(dir);
    cpSync(join(repoRoot, "templates", "postgres"), dir, { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const config = join(dir, "yodel.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(/^( {2}ci: \{ forges: \[[^\]]*\])( \},)$/m, `$1, login: { aws: { roleArn: "${ROLE}" } }$2`));
    execFileSync("git", ["init", "-q"], { cwd: dir });
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
      [`{ environments: { prod: { aws: { roleArn: "${ROLE}", region: "x" } } } }`, "ci.login.environments.prod.aws.region: unknown setting"],
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

  it("GitHub requests the token, GitLab writes its ID token, Forgejo needs a token file", () => {
    for (const l of [aws, gcp, azure]) {
      const gh = loginSteps("github", [l]);
      expect(gh.steps).toHaveLength(1);
      expect(gh.steps[0]?.lines[0]).toMatch(/^node -e '.*ACTIONS_ID_TOKEN_REQUEST_URL.*' '[^']+' "\$RUNNER_TEMP\/yodel-(aws|gcp|azure)-token"$/);
      expect(gh.variables).toEqual({});
      const gl = loginSteps("gitlab", [l]);
      expect(gl.steps[0]?.lines[0]).toMatch(/^\(umask 077 && printf '%s' "\$(AWS|GCP|AZURE)_ID_TOKEN" > "\/tmp\/yodel-(aws|gcp|azure)-token"\)$/);
      expect(gl.steps[0]?.lines.join("\n")).not.toContain("GITHUB_ENV");
      expect(Object.keys(gl.variables).length).toBeGreaterThan(0);
      expect(loginSteps("forgejo", [l]).steps).toEqual([]);
    }
    expect(loginSteps("gitlab", [aws]).variables).toEqual({ AWS_ROLE_ARN: ROLE, AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/yodel-aws-token", AWS_ROLE_SESSION_NAME: "yodel" });
    // AWS needs no command: the aws command line reads the variables.
    expect(loginSteps("gitlab", [aws]).steps[0]?.lines).toHaveLength(1);
  });

  it("logs a job in once per cloud, and refuses two environments with different logins for one", () => {
    const cloudOf = (env: string) => (env === "dev" || env === "prod" ? "rds-iam" : undefined);
    const held = [["prod", "writer"], ["dev", "reader"]] as const;
    expect(jobLogins({ aws: { roleArn: ROLE } }, held, cloudOf)).toEqual([aws]);
    expect(jobLogins(undefined, held, cloudOf)).toEqual([]);
    expect(() => jobLogins({ aws: { roleArn: ROLE }, environments: { prod: { aws: { roleArn: PROD_ROLE } } } }, held, cloudOf)).toThrow(/a job holds prod's and dev's roles, which log in to aws differently/);
  });
});
