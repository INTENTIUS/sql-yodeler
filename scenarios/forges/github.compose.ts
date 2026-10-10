/**
 * The mock GitHub (./mock-github.ts) as a Compose project, declared with
 * chant's docker lexicon: one service running the mock's source, mounted
 * as an inline Compose config, with node's type stripping. Compose
 * interpolates `$` in a config's content too, so each is written `$$`.
 *
 * Its port is published on every address of the Docker host, at a port
 * Docker picks: act runs the jobs on the host network (as GitHub runs them
 * on the runner's host), and a host-network container reaches a published
 * port only when it is not bound to 127.0.0.1 alone.
 */

import { readFileSync } from "node:fs";
import type { Declarable } from "@intentius/chant/declarable";
import { DockerConfig, Service } from "@intentius/chant-lexicon-docker";
import { NODE_IMAGE } from "./forge.js";

/** The port the mock listens on in its container. */
export const MOCK_PORT = 8188;
/** The service key, so the container is `<project>-mock-github-1`. */
export const MOCK_SERVICE = "mock-github";

export function mockGithubEntities(opts: { token: string; user: string }): Map<string, Declarable> {
  const source = new DockerConfig({ content: readFileSync(new URL("./mock-github.ts", import.meta.url), "utf8").replaceAll("$", "$$$$") });
  return new Map<string, Declarable>([
    ["mock-github-source", source],
    [
      MOCK_SERVICE,
      new Service({
        image: NODE_IMAGE,
        command: ["node", "/mock/server.ts"],
        environment: { PORT: String(MOCK_PORT), MOCK_TOKEN: opts.token, MOCK_USER: opts.user, MOCK_DATA: "/tmp/mock-github" },
        ports: [String(MOCK_PORT)],
        configs: [{ source, target: "/mock/server.ts" }],
      }),
    ],
  ]);
}
