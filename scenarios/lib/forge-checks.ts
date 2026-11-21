/**
 * The forge a claim's release cut reads the merge commit's checks from
 * (#395). Under `release.green: "forge-checks"`, `chant release cut` asks
 * the forge for the commit's statuses with the job's token. A claim that
 * runs the merge's jobs itself, the way a forge runs them, has no forge, so
 * this serves the one request the gate makes of Forgejo: the combined status
 * of a commit (`GET /api/v1/repos/<repo>/commits/<sha>/status`), with the
 * statuses the claim posted, to a request that carries the token. The branch
 * protections answer 404, which chant reads as no required check. Any other
 * request answers 404 (a GET) or 201 (a POST, such as a refused wave's
 * response), and is kept, so a claim can say what was asked.
 *
 * `env` is what a Forgejo job's step carries for the cut: `FORGEJO_ACTIONS`,
 * which tells chant it runs in a Forgejo job, the server, the repository and
 * the token.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** A status the claim posts on a commit, as Forgejo keeps it. */
export interface CommitStatus {
  context: string;
  state: "success" | "failure" | "pending";
}

export interface ChecksForge {
  /** A Forgejo job's variables for the cut: the marker, the server, the repository and the token. */
  env: Record<string, string>;
  /** Posts a status on `sha`, as another workflow on the merge commit would. */
  post(sha: string, status: CommitStatus): void;
  /** The commits whose combined status was read with the token, in order. */
  readStatusOf: string[];
  /** Requests that did not carry the token. */
  refused: string[];
  close(): Promise<void>;
}

const REPO = "claims/pipeline";

/** Starts the forge on a free port of 127.0.0.1. */
export async function checksForge(): Promise<ChecksForge> {
  const token = randomBytes(16).toString("hex");
  const statuses = new Map<string, Array<CommitStatus & { id: number; updated_at: string }>>();
  const readStatusOf: string[] = [];
  const refused: string[] = [];
  let id = 0;
  const statusPath = new RegExp(`^/api/v1/repos/${REPO}/commits/([0-9a-f]{40,64})/status(?:\\?.*)?$`);
  const answer = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    const url = req.url ?? "/";
    if (req.headers.authorization !== `token ${token}`) {
      refused.push(`${req.method ?? "GET"} ${url}`);
      answer(res, 401, { message: "token is required" });
      return;
    }
    const at = statusPath.exec(url);
    if (req.method === "GET" && at) {
      const sha = at[1] ?? "";
      readStatusOf.push(sha);
      const list = statuses.get(sha) ?? [];
      const state = list.length === 0 ? "" : list.some((s) => s.state === "failure") ? "failure" : list.some((s) => s.state === "pending") ? "pending" : "success";
      answer(res, 200, { sha, state, total_count: list.length, statuses: list.map((s) => ({ id: s.id, context: s.context, status: s.state, created_at: s.updated_at, updated_at: s.updated_at, target_url: "" })) });
      return;
    }
    answer(res, req.method === "POST" ? 201 : 404, req.method === "POST" ? {} : { message: "not found" });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the checks forge has no port");
  const url = `http://127.0.0.1:${String(address.port)}`;
  return {
    env: { FORGEJO_ACTIONS: "true", FORGEJO_SERVER_URL: url, FORGEJO_REPOSITORY: REPO, FORGEJO_TOKEN: token },
    post(sha, status) {
      const list = statuses.get(sha) ?? [];
      list.push({ ...status, id: ++id, updated_at: new Date().toISOString() });
      statuses.set(sha, list);
    },
    readStatusOf,
    refused,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => {
          ok();
        });
      }),
  };
}
