/**
 * The cloud login a CI job runs before yodel (#132), when a role it holds
 * has a password minted by a cloud token source. yodel.config.ts `ci.login`
 * says what to log in as ({@link CiLogin}); this renders the steps per
 * forge. Nothing here calls a cloud: the rendered job does, when it runs.
 *
 * On GitHub and GitLab the login is chant's ci-identity trade (#296,
 * chant#4554): one step trades the job's OIDC token for every cloud the job
 * holds a role in, from `/` with no file of the checkout in reach, and
 * writes the cloud's variables for the job's later steps. The sql lexicon's
 * token sources mint the database token from what the trade left
 * (chant#4572): `rds-iam` with the traded AWS keys, `cloud-sql-iam` from the
 * traded Google token, `entra` from the Azure Database token, so the image
 * needs no `aws`, `gcloud` or `az`. yodel keeps only the mapping from
 * `ci.login` to chant's trade spec ({@link tradeSpec}). The trade's GitLab
 * `id_tokens` are chant's (`CHANT_ID_TOKEN_<CLOUD>`).
 *
 * Forgejo gives a job no OIDC token, so there is nothing to trade: a login
 * is rendered only when the config's `tokenFile` names a token the runner
 * provides, and it is yodel's own, from that file:
 * - aws: AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_SESSION_NAME,
 *   which the aws command line assumes the role with.
 * - gcp: an external_account credential configuration over the token file
 *   (the workload identity provider, impersonating the service account),
 *   `gcloud auth login --cred-file` with it, and GOOGLE_APPLICATION_CREDENTIALS.
 * - azure: `az login --service-principal --federated-token`, and
 *   AZURE_CLIENT_ID, AZURE_TENANT_ID and AZURE_FEDERATED_TOKEN_FILE.
 * The variables go to $GITHUB_ENV, so every later step has them (the
 * report too). Yodel's own login on GitHub and GitLab, from before the
 * trade, left in 0.12 (#303).
 */

import { gitlabTradeIdTokens, gitlabTradeLines, TRADE_SPEC_ENV, tradeLine } from "@intentius/chant/ci-identity";
import type { AwsLogin, AzureLogin, CiLogin, CloudLogins, GcpLogin } from "../config/define.js";
import type { CloudToken, Role } from "../credentials.js";

/** One job's trade, in chant's `CloudTradeSpec` shape, the parts yodel fills. */
export interface TradeSpec {
  aws?: { role: string; region: string; audience: string };
  gcp?: { serviceAccount: string; provider: string; audience: string };
  azure?: { clientId: string; tenantId: string; audience: string; database: true };
}

/** yodel.config.ts `ci.login` for a job's logins, as chant's trade spec. */
export function tradeSpec(logins: readonly Login[]): TradeSpec {
  const spec: TradeSpec = {};
  for (const l of logins) {
    if (l.cloud === "aws") spec.aws = { role: l.config.roleArn, region: l.config.region ?? "us-east-1", audience: audience(l) };
    else if (l.cloud === "gcp") spec.gcp = { serviceAccount: l.config.serviceAccount, provider: l.config.workloadIdentityProvider, audience: audience(l) };
    // entra signs in to Azure Database for PostgreSQL with a token for its own scope.
    else spec.azure = { clientId: l.config.clientId, tenantId: l.config.tenantId, audience: audience(l), database: true };
  }
  return spec;
}

/** A GitLab job's `id_tokens` for its logins through chant's trade, or undefined when it has none. */
export function tradeIdTokens(logins: readonly Login[]): Record<string, { aud: string }> | undefined {
  return logins.length > 0 ? gitlabTradeIdTokens(tradeSpec(logins)) : undefined;
}

/** The trade's steps for a job on GitHub or GitLab. */
function tradeSteps(forge: "github" | "gitlab", logins: readonly Login[]): LoginSteps {
  const spec = JSON.stringify(tradeSpec(logins));
  const name = `Cloud identity (chant ci-identity: ${logins.map((l) => l.cloud).join(", ")})`;
  if (forge === "gitlab") return { steps: [{ name, lines: gitlabTradeLines() }], variables: { [TRADE_SPEC_ENV]: spec } };
  return { steps: [{ name, lines: [`export ${TRADE_SPEC_ENV}=${quote(spec)}`, tradeLine("$GITHUB_ENV", "github-env")] }], variables: {} };
}

export type Cloud = keyof CloudLogins;
export const CLOUDS: readonly Cloud[] = ["aws", "gcp", "azure"];

/** The cloud whose login a token source mints from. */
export const CLOUD_OF: Record<CloudToken, Cloud> = { "rds-iam": "aws", "cloud-sql-iam": "gcp", entra: "azure" };

export type LoginForge = "github" | "gitlab" | "forgejo";

/** One cloud's login in one job. */
export type Login = { cloud: "aws"; config: AwsLogin } | { cloud: "gcp"; config: GcpLogin } | { cloud: "azure"; config: AzureLogin };

/** What a job adds for its logins: variables every later command has, and the lines to run before yodel. */
export interface LoginSteps {
  /** Its name and its lines, in order: one step for chant's trade, or one per cloud on Forgejo. */
  steps: Array<{ name: string; lines: string[] }>;
  /** GitLab: the job's variables. On GitHub and Forgejo the lines write them to $GITHUB_ENV instead. */
  variables: Record<string, string>;
}

/** The ID token's audience a cloud accepts. GCP's is the workload identity provider's own. */
export function audience(login: Login): string {
  if (login.cloud === "aws") return "sts.amazonaws.com";
  if (login.cloud === "gcp") return `https://iam.googleapis.com/${login.config.workloadIdentityProvider}`;
  return "api://AzureADTokenExchange";
}

/** The login config for `env`'s roles minted by `token`: the environment's own, else the project's. */
export function loginFor(login: CiLogin | undefined, env: string, token: CloudToken): Login | undefined {
  const cloud = CLOUD_OF[token];
  const config = login?.environments?.[env]?.[cloud] ?? login?.[cloud];
  return config ? ({ cloud, config } as Login) : undefined;
}

/**
 * The logins of a job holding `held` roles, each cloud once. A job logs in
 * once per cloud, so two environments it holds that name different logins
 * for one cloud are refused.
 */
export function jobLogins(login: CiLogin | undefined, held: ReadonlyArray<readonly [string, Role]>, cloudOf: (env: string, role: Role) => CloudToken | undefined): Login[] {
  const out = new Map<Cloud, { login: Login; env: string }>();
  for (const [env, role] of held) {
    const token = cloudOf(env, role);
    if (!token) continue;
    const l = loginFor(login, env, token);
    if (!l) continue;
    const seen = out.get(l.cloud);
    if (seen && JSON.stringify(seen.login.config) !== JSON.stringify(l.config)) {
      throw new Error(`yodel.config.ts ci.login: a job holds ${seen.env}'s and ${env}'s roles, which log in to ${l.cloud} differently; a job logs in once per cloud, so give them one ${l.cloud} login`);
    }
    if (!seen) out.set(l.cloud, { login: l, env });
  }
  return CLOUDS.flatMap((c) => {
    const l = out.get(c)?.login;
    return l ? [l] : [];
  });
}

/** Writes the gcloud credential configuration: `node -e '<this>' <provider> <service account> <token file> <config file>`. */
const GCP_CREDENTIALS =
  'const [provider, sa, token, file] = process.argv.slice(1); require("fs").writeFileSync(file, JSON.stringify({ type: "external_account", audience: "//iam.googleapis.com/" + provider, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + sa + ":generateAccessToken", credential_source: { file: token } }, null, 2))';

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** A path that may name a variable ($RUNNER_TEMP): double-quoted, so the shell expands it. */
const path = (s: string): string => `"${s}"`;

/** The variables a cloud's login sets, from its token file (and gcp's credential configuration). */
function loginVariables(l: Login, tokenFile: string): Record<string, string> {
  if (l.cloud === "aws") return { AWS_ROLE_ARN: l.config.roleArn, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ROLE_SESSION_NAME: l.config.sessionName ?? "yodel" };
  if (l.cloud === "gcp") return { GOOGLE_APPLICATION_CREDENTIALS: `${tokenFile}.json` };
  return { AZURE_CLIENT_ID: l.config.clientId, AZURE_TENANT_ID: l.config.tenantId, AZURE_FEDERATED_TOKEN_FILE: tokenFile };
}

const STEP_NAME: Record<Cloud, string> = { aws: "Log in to AWS (web identity)", gcp: "Log in to Google Cloud (workload identity)", azure: "Log in to Azure (federated token)" };

/** A Forgejo job's login from the runner's token file; a cloud without a `tokenFile` is left out, since the runner's own identity mints there. */
function forgejoSteps(logins: readonly Login[]): LoginSteps {
  const out: LoginSteps = { steps: [], variables: {} };
  for (const l of logins) {
    const file = l.config.tokenFile;
    if (file === undefined) continue;
    const lines: string[] = [];
    if (l.cloud === "gcp") {
      lines.push(`node -e ${quote(GCP_CREDENTIALS)} ${quote(l.config.workloadIdentityProvider)} ${quote(l.config.serviceAccount)} ${path(file)} ${path(`${file}.json`)}`);
      lines.push(`gcloud auth login --cred-file=${path(`${file}.json`)} --quiet`);
    }
    if (l.cloud === "azure") {
      lines.push(`az login --service-principal --username ${quote(l.config.clientId)} --tenant ${quote(l.config.tenantId)} --federated-token "$(cat ${path(file)})" --allow-no-subscriptions --output none`);
    }
    lines.push(...Object.entries(loginVariables(l, file)).map(([k, v]) => `echo "${k}=${v}" >> "$GITHUB_ENV"`));
    out.steps.push({ name: STEP_NAME[l.cloud], lines });
  }
  return out;
}

/** The login steps of a job on `forge`, for `logins`: chant's trade on GitHub and GitLab, the runner's token file on Forgejo. */
export function loginSteps(forge: LoginForge, logins: readonly Login[]): LoginSteps {
  if (logins.length === 0) return { steps: [], variables: {} };
  return forge === "forgejo" ? forgejoSteps(logins) : tradeSteps(forge, logins);
}

// ── yodel.config.ts ci.login, checked ───────────────────────────────────────

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const PROVIDER = /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const SERVICE_ACCOUNT = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const AZURE_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A path, optionally under a variable ($RUNNER_TEMP/...): nothing a shell would read as more than that. */
const TOKEN_FILE = /^(\$[A-Z_][A-Z0-9_]*)?[\w./-]+$/;
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const FIELDS: Record<Cloud, Record<string, { re: RegExp; what: string; required: boolean }>> = {
  aws: {
    roleArn: { re: ROLE_ARN, what: "a role ARN, arn:aws:iam::<account>:role/<name>", required: true },
    tokenFile: { re: TOKEN_FILE, what: "a file path", required: false },
    sessionName: { re: SESSION_NAME, what: "2 to 64 of letters, digits and +=,.@_-", required: false },
    region: { re: /^[a-z]{2}(-[a-z]+)+-\d+$/, what: "an AWS region, such as eu-west-1", required: false },
  },
  gcp: {
    workloadIdentityProvider: { re: PROVIDER, what: "projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>", required: true },
    serviceAccount: { re: SERVICE_ACCOUNT, what: "<name>@<project>.iam.gserviceaccount.com", required: true },
    tokenFile: { re: TOKEN_FILE, what: "a file path", required: false },
  },
  azure: {
    clientId: { re: AZURE_ID, what: "the application (client) id, a GUID", required: true },
    tenantId: { re: AZURE_ID, what: "the directory (tenant) id, a GUID", required: true },
    tokenFile: { re: TOKEN_FILE, what: "a file path", required: false },
  },
};

function cloudsProblem(value: Record<string, unknown>, where: string, allowEnvironments: boolean): string | undefined {
  for (const [k, v] of Object.entries(value)) {
    if (k === "environments" && allowEnvironments) {
      if (!isRecord(v)) return `${where}.environments: an object keyed by environment, each { aws?, gcp?, azure? }`;
      for (const [env, logins] of Object.entries(v)) {
        if (!isRecord(logins)) return `${where}.environments.${env}: expected { aws?, gcp?, azure? }`;
        const problem = cloudsProblem(logins, `${where}.environments.${env}`, false);
        if (problem) return problem;
      }
      continue;
    }
    if (!(CLOUDS as readonly string[]).includes(k)) return `${where}.${k}: unknown setting (expected ${[...CLOUDS, ...(allowEnvironments ? ["environments"] : [])].join(", ")})`;
    const fields = FIELDS[k as Cloud];
    if (!isRecord(v)) return `${where}.${k}: expected { ${Object.keys(fields).join(", ")} }`;
    for (const f of Object.keys(v)) if (!(f in fields)) return `${where}.${k}.${f}: unknown setting (expected ${Object.keys(fields).join(", ")})`;
    for (const [f, spec] of Object.entries(fields)) {
      const x = v[f];
      if (x === undefined && !spec.required) continue;
      if (typeof x !== "string" || !spec.re.test(x)) return `${where}.${k}.${f}: ${spec.what}`;
    }
  }
  return undefined;
}

/** What is wrong with yodel.config.ts `ci.login`, if anything. */
export function loginProblem(value: unknown, where: string): string | undefined {
  if (!isRecord(value)) return `${where}: expected { aws?, gcp?, azure?, environments? }`;
  return cloudsProblem(value, where, true);
}
