# Working on SQL Yodeler. `just` with no target lists the targets. Each one
# wraps one npm script or command (`just --show <target>` prints it), and
# running that command does the same without just.

# List the targets.
default:
    @just --list --unsorted

# Build, then typecheck, lint and test: what CI's check job runs.
check:
    npm run build && npm run check

# The scenario claims against the emulator; extra arguments go to scenarios/run.ts (just claims resume drift).
claims *args:
    npm run claims -- {{args}}

# Build against a local chant instead of the pin, with chant's `chant dev
# local`: `just chant-local <chant-dir>` packs that checkout, installs it with
# --no-save, runs `npm run build` and the bundle check, and `just chant-local
# --reset` goes back to the pin. Each installed chant package gets a chantLocal
# field naming the chant commit. For chant's origin/main, make a worktree of it
# first. Never commit from a local build: run --reset first.
chant-local +args:
    npx chant dev local {{args}} --build 'npm run build'

# The claims the change since base can affect.
claims-affected base="origin/main":
    npm run claims -- --affected {{base}}

# The claims' status page, from claims-record.json.
claims-page:
    npm run claims:page

# Build the CI image of one set (debian, chainguard or both) from npm pack of this checkout into the local Docker daemon, and run yodel --version in it. Nothing is pushed. The Chainguard Dockerfile needs a chant whose CI images take base.
images set="both":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{set}}" in
      debian) sets="debian" ;;
      chainguard) sets="chainguard" ;;
      both) sets="debian chainguard" ;;
      *) echo "images: set is debian, chainguard or both, not {{set}}" >&2; exit 2 ;;
    esac
    version="$(node -p 'require("./package.json").version')"
    ctx="$(mktemp -d)"
    npm pack --silent --pack-destination "$ctx"
    pins="$(node -p 'const l=require("./package-lock.json");Object.entries(l.packages).filter(([k,v])=>/^node_modules\/@intentius\/chant[^/]*$/.test(k)&&!v.dev).map(([k,v])=>k.slice(13)+"@"+v.version).join(" ")')"
    for s in $sets; do
      dir=".github/image"; [ "$s" = chainguard ] && dir=".github/image-chainguard"
      docker build -f "$dir/Dockerfile" --build-arg "YODEL_VERSION=$version" --build-arg "YODEL_PACKAGE=/ctx/intentius-sql-yodeler-$version.tgz" --build-arg "CHANT_PINS=$pins" -t "yodel-ci:$s" "$ctx"
      docker run --rm "yodel-ci:$s" yodel --version
    done

# Render .github/workflows/ from .github/src/.
workflows:
    npm run workflows

# Build the docs site, as CI does.
site:
    npm --prefix docs-site ci && npm --prefix docs-site run build

# Serve the docs site at http://localhost:4321/sql-yodeler/; restart it to pick up edits under docs/.
serve:
    npm --prefix docs-site ci && npm --prefix docs-site run dev

# Measure what yodel costs as a schema and a history grow.
bench:
    npm run bench

# Start the release of package.json's version: one dispatched run of publish.yml, chant's release workflow (AGENTS.md, Releasing).
release:
    npm run release

# The e2e suites, writing only to databases and schemas named <prefix>_*; YODEL_E2E_CLICKHOUSE_URL and YODEL_E2E_POSTGRES_* say where the emulator is (test/e2e/emulator.ts).
e2e prefix *args:
    YODEL_E2E_PREFIX={{prefix}} npx vitest run test/e2e {{args}}

# Start chant's emulator, from examples/clickhouse (it needs a project on the sql lexicon). Shared: never stop or restart one someone else may be using.
emulator-up:
    cd examples/clickhouse && ../../node_modules/.bin/chant emulator up --lexicon sql
