/**
 * `yodel ci --replay` (#65; the templates' `npm run replay` before it): the
 * pull request's lint job's replay check, on this machine.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { environments, REPLAY, REPLAY_PROFILE, REPLAY_SERVICE, variablePrefix } from "./render.js";

const docker = (args: string[]): { code: number; out: string } => {
  const ran = spawnSync("docker", args, { encoding: "utf8" });
  if (ran.error) throw new Error(`docker: ${ran.error.message}; yodel ci --replay needs Docker`);
  return { code: ran.status ?? 1, out: `${ran.stdout}${ran.stderr}`.trim() };
};

/**
 * `yodel ci --replay [-- <yodel lint options>]`: the lint job's replay check,
 * run here. Starts a throwaway server with Docker from the image the lint
 * job's service runs, published on a port Docker picks on 127.0.0.1; points
 * the `replay` profile at it (REPLAY_<DIALECT>_URL and the server's
 * credentials); runs REPLAY; and removes the server, whatever the result.
 * The exit code is yodel's.
 *
 * A server of its own because the replay drops and replays the databases
 * (or schemas) the history names, and those are dev's names too: against
 * the emulator dev uses on this machine, --reset would drop dev's.
 */
export async function replayLocally(dir: string, args: readonly string[]): Promise<number> {
  const { dialect, replay } = await environments(dir);
  if (!replay) throw new Error(`chant.config.ts declares no sql.profiles.${REPLAY_PROFILE}, so there is no replay check to run`);
  const svc = REPLAY_SERVICE[dialect];
  const name = `yodel-replay-${randomBytes(4).toString("hex")}`;
  const env = Object.entries(svc.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const started = docker(["run", "--detach", "--rm", "--name", name, "--publish", `127.0.0.1::${String(svc.port)}`, ...env, svc.image]);
  if (started.code !== 0) throw new Error(`could not start the replay server (${svc.image}):\n${started.out}`);
  const stop = () => docker(["rm", "--force", "--volumes", name]);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  try {
    const published = /:(\d+)\s*$/m.exec(docker(["port", name, `${String(svc.port)}/tcp`]).out)?.[1];
    if (!published) throw new Error(`docker did not publish ${name}'s port ${String(svc.port)}`);
    process.stderr.write(`replay server ${name} (${svc.image}) on 127.0.0.1:${published}\n`);
    // The service's own health check, run in the container, until it passes.
    for (let i = 0; docker(["exec", name, "sh", "-c", svc.health]).code !== 0; i++) {
      if (i >= 90) throw new Error(`${name} did not pass \`${svc.health}\` in 90 s`);
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    // This yodel (its bin, under this node), not whichever is first on PATH.
    const [, ...rest] = REPLAY.split(" ");
    const bin = process.argv[1];
    const [cmd, lead] = bin ? [process.execPath, [bin]] : ["yodel", []];
    const ran = spawnSync(cmd, [...lead, ...rest, ...args], {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, [`${variablePrefix(REPLAY_PROFILE, dialect)}_URL`]: svc.url("127.0.0.1", Number(published)), ...svc.jobEnv },
    });
    if (ran.error) throw new Error(`${REPLAY}: ${ran.error.message}`);
    return ran.status ?? 1;
  } finally {
    stop();
  }
}

