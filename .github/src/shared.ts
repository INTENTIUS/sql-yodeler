/**
 * Steps more than one workflow uses. Functions, not Declarables, so nothing
 * here renders on its own.
 */

import { Step } from "@intentius/chant-lexicon-github";

type AStep = InstanceType<typeof Step>;

export const checkout = (): AStep => new Step({ uses: "actions/checkout@v4" });

export const setupNode = (version: number, cache = true): AStep =>
  new Step({ uses: "actions/setup-node@v4", with: { "node-version": String(version), ...(cache ? { cache: "npm" } : {}) } });

/** Where the claims find the emulator on the runner, and where each run's log goes. */
export const claimsEnv: Record<string, string> = {
  YODEL_CLAIMS_CLICKHOUSE_URL: "http://localhost:8123",
  YODEL_CLAIMS_POSTGRES_URL: "postgres://localhost:5432/postgres",
  YODEL_CLAIMS_LOG_DIR: "${{ github.workspace }}/claims-logs",
};

/**
 * The sql emulator on the runner, up and answering. Needs the checkout and
 * `npm ci` before it: the image list and chant come from them.
 */
export const emulatorSteps = (): AStep[] => [
  // Docker Hub's anonymous pull limit, shared by the runners' addresses,
  // refuses pulls often. The pinned images come from Google's mirror of
  // Docker Hub instead: copied, digests and all, into a registry on the
  // runner that the Docker daemon uses as its Docker Hub mirror, so chant
  // and the Keeper cluster pull them by their usual names and digests.
  new Step({
    name: "Serve the emulator's images from a local mirror",
    run: `echo '{ "registry-mirrors": ["http://localhost:5000"] }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
docker run -d --restart always --name hub-mirror -p 5000:5000 mirror.gcr.io/library/registry:2
command -v skopeo || { sudo apt-get update -q && sudo apt-get install -y -q skopeo; }
for ref in $(npx tsx scenarios/images.ts); do
  repo="\${ref%%:*}"; rest="\${ref#*:}"; tag="\${rest%%@*}"; digest="\${ref#*@}"
  case "$repo" in */*) path="$repo" ;; *) path="library/$repo" ;; esac
  for _ in 1 2 3; do
    skopeo copy -q --all --preserve-digests --dest-tls-verify=false "docker://mirror.gcr.io/$path@$digest" "docker://localhost:5000/$path:$tag" && break
    sleep 20
  done
  docker pull -q "$ref"
done
`,
  }),
  // chant emulator up reads the lexicons from a project's chant.config.ts.
  // Retried: Docker Hub's anonymous pull limit refuses a pull now and then.
  new Step({
    name: "Start the emulator",
    "working-directory": "scenarios/fixtures/clickhouse",
    run: `for i in 1 2 3; do
  timeout 600 npx chant emulator up --lexicon sql && exit 0
  sleep $((i * 30))
done
exit 1
`,
  }),
  new Step({
    name: "Wait for ClickHouse and Postgres",
    run: `for _ in $(seq 1 60); do
  curl -fsS http://localhost:8123/ping >/dev/null && docker exec chant-postgres pg_isready -U postgres >/dev/null && exit 0
  sleep 2
done
docker ps -a
exit 1
`,
  }),
];
