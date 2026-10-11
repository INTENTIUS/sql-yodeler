/**
 * The gitlab claim's runner as a Compose project, declared with
 * chant's docker lexicon: a gitlab-runner with the docker executor,
 * registered to the claim's project alone, on the GitLab's network (so a
 * job clones from and calls the API at GitLab's external_url, as the
 * runner does), its config.toml an inline Compose config.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { DockerConfig, Network, Service } from "@intentius/chant-lexicon-docker";
import { NODE_IMAGE } from "./forge.js";

export const RUNNER_IMAGE = "gitlab/gitlab-runner:v17.11.0";

export interface RunnerOptions {
  /** GitLab's URL as the runner and the jobs reach it, on `network`. */
  url: string;
  /** The runner's authentication token (glrt-...), from POST /user/runners. */
  token: string;
  name: string;
  /** The existing Docker network GitLab answers on. */
  network: string;
}

function configToml(o: RunnerOptions): string {
  const q = JSON.stringify;
  return [
    "concurrent = 2",
    "check_interval = 2",
    "",
    "[[runners]]",
    `  name = ${q(o.name)}`,
    `  url = ${q(o.url)}`,
    `  token = ${q(o.token)}`,
    '  executor = "docker"',
    "  [runners.docker]",
    `    image = ${q(NODE_IMAGE)}`,
    `    network_mode = ${q(o.network)}`,
    '    pull_policy = ["if-not-present"]',
    '    volumes = ["/cache"]',
    "",
  ].join("\n");
}

export function gitlabRunnerEntities(o: RunnerOptions): Map<string, Declarable> {
  const config = new DockerConfig({ content: configToml(o).replaceAll("$", "$$$$") });
  return new Map<string, Declarable>([
    ["gitlab", new Network({ name: o.network, external: true })],
    ["runner-config", config],
    [
      "runner",
      new Service({
        image: RUNNER_IMAGE,
        command: ["run", "--config", "/etc/yodel-runner/config.toml", "--working-directory", "/home/gitlab-runner"],
        volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
        networks: ["gitlab"],
        configs: [{ source: config, target: "/etc/yodel-runner/config.toml" }],
      }),
    ],
  ]);
}
