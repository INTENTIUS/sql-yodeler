/**
 * A small GitHub for the template-github claim: the REST calls the claim and
 * `yodel plan --comment` make, and the repositories' git over smart HTTP
 * (git http-backend). It runs in a container (./github.compose.ts) with
 * node's type stripping, so it imports node's modules only. State is in
 * memory and under MOCK_DATA, and goes with the container.
 *
 *   POST   /api/v3/user/repos                        a repository for MOCK_USER
 *   DELETE /api/v3/repos/:o/:r
 *   GET    /api/v3/repos/:o/:r/branches/:branch
 *   POST   /api/v3/repos/:o/:r/pulls                 open a pull request
 *   PUT    /api/v3/repos/:o/:r/pulls/:n/merge        a merge commit on the base branch
 *   GET|POST /api/v3/repos/:o/:r/issues/:n/comments  (per_page and page)
 *   PATCH  /api/v3/repos/:o/:r/issues/comments/:id
 *   GET|POST /:o/:r.git/...                          git; a push needs the token
 *
 * Writes take `Authorization: Bearer <MOCK_TOKEN>` (or `token`), git pushes
 * basic auth with the token as the password. Reads are open.
 *
 * Adapted from terragucci's stack/mock-github/server.mjs.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8188);
const DATA = process.env.MOCK_DATA ?? "/tmp/mock-github";
const TOKEN = process.env.MOCK_TOKEN ?? "";
const USER = process.env.MOCK_USER ?? "yodel34";
mkdirSync(DATA, { recursive: true });

interface Pull {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  head: string;
  base: string;
  title: string;
}
interface Comment {
  id: number;
  issue: number;
  body: string;
  user: { login: string };
}
interface Repo {
  pulls: Pull[];
  comments: Comment[];
}

const repos = new Map<string, Repo>();
let commentId = 0;
const repoDir = (o: string, r: string) => join(DATA, o, `${r}.git`);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha = (dir: string, ref: string): string | null => {
  try {
    return git(dir, "rev-parse", "--verify", `refs/heads/${ref}`);
  } catch {
    return null;
  }
};

function json(res: ServerResponse, code: number, body?: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      ok(Buffer.concat(chunks));
    });
  });
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  if (!TOKEN) return false;
  if (/^(Bearer|token) /i.test(h)) return h.replace(/^\S+ /, "") === TOKEN;
  if (/^Basic /i.test(h)) return Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":") === TOKEN;
  return false;
}

function pullJson(o: string, r: string, p: Pull) {
  const dir = repoDir(o, r);
  return { number: p.number, state: p.state, merged: p.merged, title: p.title, head: { ref: p.head, sha: sha(dir, p.head) }, base: { ref: p.base, sha: sha(dir, p.base) } };
}

/** A merge commit of the pull request's head on its base, pushed to the bare repository. */
function merge(o: string, r: string, p: Pull): string {
  const tmp = mkdtempSync(join(DATA, "merge-"));
  try {
    git(tmp, "init", "-q");
    git(tmp, "fetch", "-q", repoDir(o, r), `+refs/heads/${p.base}:refs/remotes/o/${p.base}`, `+refs/heads/${p.head}:refs/remotes/o/${p.head}`);
    git(tmp, "checkout", "-q", "-B", p.base, `o/${p.base}`);
    git(tmp, "-c", "user.name=mock-github", "-c", "user.email=mock@github.invalid", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `Merge pull request #${String(p.number)} from ${p.head}`, `o/${p.head}`);
    git(tmp, "push", "-q", repoDir(o, r), `HEAD:refs/heads/${p.base}`);
    return git(tmp, "rev-parse", "HEAD");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** git's smart HTTP through git http-backend. */
function backend(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer, o: string, r: string, rest: string): void {
  if (!existsSync(repoDir(o, r))) {
    json(res, 404, { message: "Not Found" });
    return;
  }
  const push = url.searchParams.get("service") === "git-receive-pack" || rest.endsWith("git-receive-pack");
  if (push && !authed(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="mock-github"' });
    res.end();
    return;
  }
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: join(DATA, o),
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${r}.git${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      REMOTE_USER: USER,
      REMOTE_ADDR: "127.0.0.1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.receivepack",
      GIT_CONFIG_VALUE_0: "true",
    },
  });
  child.stdin.end(body);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => chunks.push(d));
  child.on("close", () => {
    const out = Buffer.concat(chunks);
    const split = out.indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of out.subarray(0, split).toString().split("\r\n")) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(split + 4));
  });
}

function api(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
  const path = url.pathname.replace(/^\/api\/v3/, "");
  if (req.method !== "GET" && !authed(req)) {
    json(res, 401, { message: "Bad credentials" });
    return;
  }
  const data = (body.length ? JSON.parse(body.toString()) : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof data[k] === "string" ? data[k] : "");

  if (req.method === "POST" && path === "/user/repos") {
    const name = str("name");
    const dir = repoDir(USER, name);
    if (!name || existsSync(dir)) {
      json(res, 422, { message: "name already exists on this account" });
      return;
    }
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "--bare", "-b", "main");
    repos.set(`${USER}/${name}`, { pulls: [], comments: [] });
    json(res, 201, { name, full_name: `${USER}/${name}`, default_branch: "main" });
    return;
  }
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
  const [top, o = "", r = ""] = seg;
  if (top !== "repos" || !existsSync(repoDir(o, r))) {
    json(res, 404, { message: "Not Found" });
    return;
  }
  const st = repos.get(`${o}/${r}`) ?? { pulls: [], comments: [] };
  repos.set(`${o}/${r}`, st);
  const rest = seg.slice(3);

  if (rest.length === 0 && req.method === "DELETE") {
    rmSync(repoDir(o, r), { recursive: true, force: true });
    repos.delete(`${o}/${r}`);
    json(res, 204);
    return;
  }
  if (rest[0] === "branches" && req.method === "GET") {
    const name = rest.slice(1).join("/");
    const s = sha(repoDir(o, r), name);
    if (s) json(res, 200, { name, commit: { sha: s } });
    else json(res, 404, { message: "Branch not found" });
    return;
  }
  if (rest[0] === "pulls" && rest.length === 1 && req.method === "POST") {
    const dir = repoDir(o, r);
    const head = str("head");
    const base = str("base");
    if (!sha(dir, head) || !sha(dir, base)) {
      json(res, 422, { message: "Validation Failed: head or base is not a branch" });
      return;
    }
    const p: Pull = { number: st.pulls.length + 1, state: "open", merged: false, head, base, title: str("title") };
    st.pulls.push(p);
    json(res, 201, pullJson(o, r, p));
    return;
  }
  if (rest[0] === "pulls" && rest.length >= 2) {
    const p = st.pulls.find((x) => x.number === Number(rest[1]));
    if (!p) {
      json(res, 404, { message: "Not Found" });
      return;
    }
    if (rest[2] === "merge" && req.method === "PUT") {
      if (p.state !== "open") {
        json(res, 405, { message: "Pull Request is not mergeable" });
        return;
      }
      const merged = merge(o, r, p);
      p.state = "closed";
      p.merged = true;
      json(res, 200, { merged: true, sha: merged, message: "Pull Request successfully merged" });
      return;
    }
    if (rest.length === 2 && req.method === "GET") {
      json(res, 200, pullJson(o, r, p));
      return;
    }
  }
  if (rest[0] === "issues" && rest[1] === "comments" && rest.length === 3 && req.method === "PATCH") {
    const c = st.comments.find((x) => x.id === Number(rest[2]));
    if (!c) {
      json(res, 404, { message: "Not Found" });
      return;
    }
    c.body = str("body") || c.body;
    json(res, 200, c);
    return;
  }
  if (rest[0] === "issues" && rest[2] === "comments" && rest.length === 3) {
    const issue = Number(rest[1]);
    if (req.method === "GET") {
      const per = Number(url.searchParams.get("per_page") ?? 30) || 30;
      const page = Number(url.searchParams.get("page") ?? 1) || 1;
      json(res, 200, st.comments.filter((c) => c.issue === issue).slice((page - 1) * per, page * per));
      return;
    }
    if (req.method === "POST") {
      const c: Comment = { id: ++commentId, issue, body: str("body"), user: { login: USER } };
      st.comments.push(c);
      json(res, 201, c);
      return;
    }
  }
  json(res, 404, { message: "Not Found" });
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  void readBody(req).then((body) => {
    try {
      process.stdout.write(`${req.method ?? ""} ${url.pathname}\n`);
      if (url.pathname === "/__mock/health") {
        json(res, 200, { ok: true });
        return;
      }
      const g = /^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/.exec(url.pathname);
      if (g) {
        backend(req, res, url, body, g[1] ?? "", g[2] ?? "", g[3] ?? "/");
        return;
      }
      if (url.pathname.startsWith("/api/v3/")) {
        api(req, res, url, body);
        return;
      }
      json(res, 404, { message: "Not Found" });
    } catch (e) {
      json(res, 500, { message: String(e) });
    }
  });
}).listen(PORT, () => {
  process.stdout.write(`mock-github on :${String(PORT)}, data in ${DATA}\n`);
});
