---
claims: [approval]
type: howto
---

# Applying from Kubernetes

A team that deploys with Kubernetes can apply its migrations from the cluster: a Job, or a Helm hook, runs `yodel apply <env>` before the rollout. The Job applies only a plan a person already approved, under the same lock and history as an apply from CI. The approval itself is never given in the cluster.

The pipelines `yodel ci` renders do the same from CI ([The pipelines](workflows.md#the-pipelines-yodel-ci)); use this page when the cluster, not CI, runs the deploy.

## What the Job needs

- The CI image, pinned by its digest: `ghcr.io/intentius/sql-yodeler:<version>@sha256:<digest>`. It carries Node, yodel, chant and the lexicons, so the Job runs no `npm ci`. Use the version the project's `package.json` installs.
- The project at the commit being deployed, as a git checkout with the `chant/lifecycle` branch fetched: the approvals are commits on that branch ([Approval](approval.md)). An init container that clones the repository at the deployed commit does this.
- The environment's writer, from a Secret, in the variables the profile reads (`PROD_POSTGRES_WRITER_USER`, `PROD_POSTGRES_WRITER_PASSWORD`, and the reader's pair), and `YODEL_CREDENTIALS=writer:<env>` ([Credentials](configuration.md#credentials-a-reader-and-a-writer)).
- A token that can read the repository, for the clone and the fetch.

## The Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: yodel-apply-prod
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      volumes:
        - name: project
          emptyDir: {}
      initContainers:
        - name: checkout
          image: alpine/git:<tag>
          env:
            - name: GIT_TOKEN
              valueFrom: { secretKeyRef: { name: yodel-git, key: token } }
            - name: COMMIT
              value: "<the deployed commit>"
          command: ["sh", "-c"]
          args:
            - |
              git clone -q "https://x-access-token:${GIT_TOKEN}@github.com/acme/schema.git" /work
              cd /work
              git checkout -q "$COMMIT"
              git fetch -q origin chant/lifecycle:chant/lifecycle
          volumeMounts: [{ name: project, mountPath: /work }]
      containers:
        - name: apply
          image: ghcr.io/intentius/sql-yodeler:0.10.0@sha256:<digest>
          workingDir: /work
          command: ["yodel", "apply", "prod", "--lock-wait", "10m"]
          env:
            - name: YODEL_CREDENTIALS
              value: writer:prod
          envFrom:
            - secretRef: { name: yodel-prod-db }
          volumeMounts: [{ name: project, mountPath: /work }]
```

`yodel-prod-db` holds `PROD_POSTGRES_READER_USER`, `PROD_POSTGRES_READER_PASSWORD`, `PROD_POSTGRES_WRITER_USER` and `PROD_POSTGRES_WRITER_PASSWORD` (or the `CLICKHOUSE` names).

As a Helm hook, the same Job takes these annotations, so it runs before each install and upgrade and is replaced on the next:

```yaml
metadata:
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-delete-policy: before-hook-creation
```

## Approving before the rollout

The Job does not wait for an approval. With migrations pending and no approval of their plan digest on `chant/lifecycle`, `yodel apply` stops at the gate, prints the plan and the command to approve it, and exits 3; with `backoffLimit: 0` the Job fails and the rollout does not start.

Approve first, from a terminal, with the reader's credentials:

```sh
npx yodel plan prod                        # what the Job will run, and its digest
npx yodel approve prod --plan <digest>     # records the approval and pushes chant/lifecycle
```

Then deploy. The Job's apply computes the digest again under the lock and applies only if it matches the approved one. If anything the plan covers changed since, it stops at the gate again and nothing is applied.

## Exit codes

| code | the Job | what to do |
|---|---|---|
| 0 | applied, or nothing was pending | the rollout goes on |
| 3 | stopped at the gate: no approval of this plan | approve it (above) and deploy again |
| 4 | refused: a checksum mismatch, out of order, a policy denial, a failed pre-check | read the Job's log; it names the migration and the reason |
| 5 | another apply held the lock for the whole `--lock-wait` | let that apply finish, then deploy again |

A migration that fails part way is recorded statement by statement; the next Job resumes at the statement that failed ([Migrations](migrations.md)).

## Two rollouts at once

The apply lock serializes Jobs: the second waits for up to `--lock-wait`, then finds nothing pending if the first applied everything ([The apply lock](migrations.md#the-apply-lock)). On Postgres the lock is an advisory lock on the server. On ClickHouse it is a `KeeperMap` row, which needs Keeper and the server setting `keeper_map_path_prefix`; without Keeper the lock is a file inside the pod, so two Jobs in different pods do not see each other's. Run ClickHouse applies from the cluster only on a server with Keeper.
