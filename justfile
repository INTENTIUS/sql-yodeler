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

# The claims the change since base can affect.
claims-affected base="origin/main":
    npm run claims -- --affected {{base}}

# The claims' status page, from claims-record.json.
claims-page:
    npm run claims:page

# Render .github/workflows/ from .github/src/.
workflows:
    npm run workflows

# Build the docs site, as CI does.
site:
    npm --prefix docs-site ci && npm --prefix docs-site run build

# Measure what yodel costs as a schema and a history grow.
bench:
    npm run bench

# Open the release pull request, or tag the release once main is at version (scripts/release.sh; --dry-run says what it would do).
release version *flags:
    npm run release -- {{version}} {{flags}}

# The e2e suites, writing only to databases and schemas named <prefix>_*; YODEL_E2E_CLICKHOUSE_URL and YODEL_E2E_POSTGRES_* say where the emulator is (test/e2e/emulator.ts).
e2e prefix *args:
    YODEL_E2E_PREFIX={{prefix}} npx vitest run test/e2e {{args}}

# Start chant's emulator, from examples/clickhouse (it needs a project on the sql lexicon). Shared: never stop or restart one someone else may be using.
emulator-up:
    cd examples/clickhouse && ../../node_modules/.bin/chant emulator up --lexicon sql
