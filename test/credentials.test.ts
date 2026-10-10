/**
 * Credentials (#50): credentials() gives a profile a reader and a writer,
 * YODEL_CREDENTIALS picks the one a process connects as, yodel refuses an
 * environment whose two roles are one identity, and yodel ci gives each job
 * the variables of the role it holds, the cloud identity a token source
 * needs, and the write probe before every plan.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { credentials, credentialsOf, roleOf, roleVariables, sharedCredentials, type Credentials } from "../src/credentials.js";
import { repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const withEnv = async <T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
};

describe("credentials()", () => {
  it("picks the reader unless YODEL_CREDENTIALS is writer or writer:<env>", () => {
    expect(roleOf("dev", undefined)).toBe("reader");
    expect(roleOf("dev", "reader")).toBe("reader");
    expect(roleOf("dev", "writer")).toBe("writer");
    expect(roleOf("dev", "writer:dev")).toBe("writer");
    expect(roleOf("dev", "writer:prod")).toBe("reader");
  });

  it("names the default variables, takes a token source for a role's password, and records both roles", async () => {
    const reader = await withEnv({ YODEL_CREDENTIALS: undefined }, () => Promise.resolve(credentials("dev", "postgres", { writer: { password: { token: "rds-iam" } } })));
    expect(reader.user).toEqual({ env: "DEV_POSTGRES_READER_USER" });
    expect(reader.password).toEqual({ env: "DEV_POSTGRES_READER_PASSWORD" });
    const writer = await withEnv({ YODEL_CREDENTIALS: "writer:dev" }, () => Promise.resolve(credentials("dev", "postgres", { writer: { password: { token: "rds-iam" } } })));
    expect(writer.user).toEqual({ env: "DEV_POSTGRES_WRITER_USER" });
    expect(writer.password).toEqual({ token: "rds-iam" });
    // Spread into a profile, the roles go with it; JSON (and chant's strict schema) does not see them.
    const profile = { url: "postgres://db:5432/app", ...writer };
    const c = credentialsOf(profile);
    expect(c?.role).toBe("writer");
    expect(roleVariables(c as Credentials, "reader")).toEqual(["DEV_POSTGRES_READER_USER", "DEV_POSTGRES_READER_PASSWORD"]);
    expect(roleVariables(c as Credentials, "writer")).toEqual(["DEV_POSTGRES_WRITER_USER"]);
    expect(Object.keys(JSON.parse(JSON.stringify(profile)) as object)).toEqual(["url", "user", "password"]);
  });

  it("finds a reader and a writer that are one identity: one user variable, one user, or one password variable", () => {
    const c = (roles: Parameters<typeof credentials>[2]) => credentialsOf(credentials("prod", "clickhouse", roles)) as Credentials;
    expect(sharedCredentials(c({}), {})).toBeUndefined();
    expect(sharedCredentials(c({}), { PROD_CLICKHOUSE_READER_USER: "app_r", PROD_CLICKHOUSE_WRITER_USER: "app_w" })).toBeUndefined();
    expect(sharedCredentials(c({ writer: { user: { env: "PROD_CLICKHOUSE_READER_USER" } } }), {})).toMatch(/^sql\.profiles\.prod: the reader and the writer read their user from the same variable, PROD_CLICKHOUSE_READER_USER/);
    expect(sharedCredentials(c({}), { PROD_CLICKHOUSE_READER_USER: "app", PROD_CLICKHOUSE_WRITER_USER: "app" })).toMatch(
      /the reader \(PROD_CLICKHOUSE_READER_USER\) and the writer \(PROD_CLICKHOUSE_WRITER_USER\) are the same user, app/,
    );
    expect(sharedCredentials(c({ reader: { password: { env: "PW" } }, writer: { password: { env: "PW" } } }), {})).toMatch(/read their password from the same variable, PW/);
    // Two token sources share no variable.
    expect(sharedCredentials(c({ reader: { password: { token: "command", command: ["./r.sh"] } }, writer: { password: { token: "command", command: ["./w.sh"] } } }), {})).toBeUndefined();
  });
});

/** A copy of the Postgres template, its profiles edited by `edit`, resolving chant, the lexicons and yodel from this checkout. */
function template(edit: (config: string) => string = (t) => t): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-credentials-"));
  temps.push(dir);
  cpSync(join(repoRoot, "templates", "postgres"), dir, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const config = join(dir, "chant.config.ts");
  const text = readFileSync(config, "utf8");
  writeFileSync(config, edit(text));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("a project's reader and writer", () => {
  it("are refused by every command, exit 4 naming them, when they are the same user", async () => {
    const dir = template((t) => t.replace(/\.\.\.credentials\(env, "postgres"\)/, '...credentials(env, "postgres", { writer: { user: { env: `${env.toUpperCase()}_POSTGRES_READER_USER` } } })'));
    for (const args of [["config", "check"], ["status", "dev"], ["new", "x"], ["ci", "--check"]]) {
      const ran = await yodel([...args, "--dir", dir]);
      expect(ran.code, `${args.join(" ")}: ${ran.err}`).toBe(4);
      expect(ran.err).toContain("refused: sql.profiles.dev: the reader and the writer read their user from the same variable, DEV_POSTGRES_READER_USER");
    }
  });

  it("are refused when the variables they name hold the same user", async () => {
    const dir = template();
    const ran = await withEnv({ PROD_POSTGRES_READER_USER: "app", PROD_POSTGRES_WRITER_USER: "app" }, () => yodel(["config", "check", "--dir", dir]));
    expect(ran.code).toBe(4);
    expect(ran.err).toContain("sql.profiles.prod: the reader (PROD_POSTGRES_READER_USER) and the writer (PROD_POSTGRES_WRITER_USER) are the same user, app");
    const apart = await withEnv({ PROD_POSTGRES_READER_USER: "app_r", PROD_POSTGRES_WRITER_USER: "app_w" }, () => yodel(["config", "check", "prod", "--dir", dir]));
    expect(apart.code, apart.err).toBe(0);
    expect(apart.out).toContain("connects as   reader (YODEL_CREDENTIALS unset)");
    expect(apart.out).toContain("reader        user PROD_POSTGRES_READER_USER (set: app_r), password PROD_POSTGRES_READER_PASSWORD (not set here)");
    expect(apart.out).toContain("writer        user PROD_POSTGRES_WRITER_USER (set: app_w), password PROD_POSTGRES_WRITER_PASSWORD (not set here)");
  });

  it("give each job the variables of the role it holds, and the cloud identity a token source mints from", async () => {
    const dir = template((t) =>
      t
        .replace('prod: postgres("prod", "postgres://db.example.com:5432/app")', 'prod: { ...postgres("prod", "postgres://db.example.com:5432/app"), ...credentials("prod", "postgres", { reader: { password: { token: "entra" } }, writer: { password: { token: "rds-iam" } } }) }')
        .replace('dev: postgres("dev", "postgres://127.0.0.1:5432/postgres")', 'dev: { ...postgres("dev", "postgres://127.0.0.1:5432/postgres"), ...credentials("dev", "postgres", { reader: { password: { token: "command", command: ["./mint.sh"] } } }) }'),
    );
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const yaml = (f: string) => parseYAMLDocument(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    type Job = { env?: Record<string, string>; steps: Array<{ name?: string; run?: string }>; id_tokens?: unknown; script?: string[] };

    // The pull request: no password variable for a token-minted reader; prod's reader is entra, so an OIDC token.
    const pr = yaml(".github/workflows/yodel-pr.yml");
    const jobs = pr.jobs as Record<string, Job>;
    expect(Object.keys(jobs["plan-dev"]?.env ?? {})).toEqual(["DEV_POSTGRES_URL", "DEV_POSTGRES_READER_USER", "YODEL_WEBHOOK_URL", "YODEL_WEBHOOK_KEY"]);
    expect(pr.permissions).toEqual({ contents: "read", "pull-requests": "write", "id-token": "write" });
    // Every plan job tries a write first, with each reader it holds.
    expect(jobs["plan-dev"]?.steps.map((s) => s.run)).toContain("yodel config check dev --write-probe");
    const prodSteps = (jobs["plan-prod"]?.steps ?? []).map((s) => s.run);
    expect(prodSteps.indexOf("yodel config check prod dev --write-probe")).toBeLessThan(prodSteps.indexOf("yodel plan prod --comment"));
    expect(prodSteps.indexOf("yodel config check prod dev --write-probe")).toBeGreaterThan(-1);

    // The apply: prod's writer is rds-iam.
    const apply = yaml(".github/workflows/yodel-apply.yml");
    expect(apply.permissions).toEqual({ contents: "write", "id-token": "write" });
    const waves = apply.jobs as Record<string, Job>;
    expect(Object.keys(waves["wave-2-prod"]?.env ?? {})).toContain("PROD_POSTGRES_WRITER_USER");
    expect(Object.keys(waves["wave-2-prod"]?.env ?? {})).not.toContain("PROD_POSTGRES_WRITER_PASSWORD");
    expect(readFileSync(join(dir, ".github/workflows/yodel-apply.yml"), "utf8")).toContain("# Cloud identity: a password here is a rds-iam token");

    // GitLab: an ID token for the cloud each job's roles mint from, and none for a job without one.
    const gitlabApply = yaml(".gitlab/yodel-apply.gitlab-ci.yml") as Record<string, Job>;
    expect(gitlabApply["wave-2-prod"]?.id_tokens).toEqual({ AWS_ID_TOKEN: { aud: "sts.amazonaws.com" } });
    expect(gitlabApply["wave-1-dev"]?.id_tokens).toBeUndefined();
    const gitlab = yaml(".gitlab-ci.yml") as Record<string, Job>;
    expect(gitlab["plan-prod"]?.id_tokens).toEqual({ AZURE_ID_TOKEN: { aud: "api://AzureADTokenExchange" } });
    expect(gitlab["plan-prod"]?.script?.[0]).toBe("yodel config check prod dev --write-probe");
    expect(gitlab["plan-dev"]?.id_tokens).toBeUndefined();
    const watch = yaml(".gitlab/yodel-watch.gitlab-ci.yml") as Record<string, Job>;
    expect(watch["watch-prod"]?.id_tokens).toEqual({ AZURE_ID_TOKEN: { aud: "api://AzureADTokenExchange" } });
    expect(watch["watch-dev"]?.id_tokens).toBeUndefined();

    // The watch on GitHub: prod's reader is entra; dev's needs no OIDC token.
    expect(yaml(".github/workflows/watch-prod.yml").permissions).toEqual({ contents: "read", issues: "write", "id-token": "write" });
    expect(yaml(".github/workflows/watch-dev.yml").permissions).toEqual({ contents: "read", issues: "write" });
    // Forgejo has no OIDC token for a job: its files say so.
    expect(readFileSync(join(dir, ".forgejo/workflows/yodel-apply.yml"), "utf8")).toContain("Forgejo gives a job no");

    // Rendered again, nothing moves.
    expect((await yodel(["ci", "--check", "--dir", dir])).code).toBe(0);
  });
});
