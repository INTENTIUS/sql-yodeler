#!/usr/bin/env bash
# Release @intentius/sql-yodeler: npm run release -- <version> [--dry-run] [--commit <sha>]
#
# Two runs make a release (AGENTS.md, Releasing):
#
#   1. origin/main's package.json is not at <version> yet: the script makes
#      branch release-<version> from origin/main with the version bumped in
#      package.json and package-lock.json, pushes it and opens the pull
#      request. It is reviewed and merged like any other.
#   2. origin/main is at <version>: the script picks the newest first-parent
#      commit on main that carries <version> and whose latest `ci` and
#      `claims` push runs both concluded success (or the commit named with
#      --commit, which must pass the same test), tags it v<version> and
#      pushes the tag. .github/workflows/publish.yml publishes on that tag.
#
# It refuses a version that is not X.Y.Z, a tag that exists here or on
# origin, a version already on npm, and a version below main's.
#
# --dry-run (-n) checks everything and says what it would do, and changes
# nothing: no branch, commit, pull request or tag.
set -euo pipefail

PKG="@intentius/sql-yodeler"
WORKFLOWS=(ci.yml claims.yml)

usage() {
  echo "usage: npm run release -- <version> [--dry-run] [--commit <sha>]" >&2
  exit 2
}

fail() {
  echo "release: $1" >&2
  exit 1
}

version=""
commit=""
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n) dry=1 ;;
    --commit)
      [ $# -ge 2 ] || usage
      commit="$2"
      shift
      ;;
    -h | --help) usage ;;
    -*) echo "release: unknown flag $1" >&2; usage ;;
    *)
      [ -z "$version" ] || fail "two versions given ($version, $1)"
      version="${1#v}"
      ;;
  esac
  shift
done
[ -n "$version" ] || usage
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "\"$version\" is not a version of the form X.Y.Z"
tag="v$version"

for tool in git gh node npm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done

cd "$(git rev-parse --show-toplevel)"
short() { git rev-parse --short "$1"; }
# version_at <rev>: package.json's version at <rev>.
version_at() {
  git show "$1:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
}
# newer <a> <b>: a is a higher X.Y.Z than b.
newer() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]
}

git fetch --quiet --tags origin main || fail "could not fetch origin"
main=$(git rev-parse origin/main)

if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null || [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  fail "$tag already exists"
fi
if [ "$(npm view "$PKG@$version" version 2>/dev/null || true)" = "$version" ]; then
  fail "$PKG@$version is already on npm"
fi

at_main=$(version_at "$main")

# --- 1. The bump, as a pull request -----------------------------------------
if [ "$at_main" != "$version" ]; then
  [ -z "$commit" ] || fail "--commit names a commit to tag, but main is at $at_main, not $version: bump it first"
  newer "$version" "$at_main" || fail "$version is not above main's version, $at_main"
  branch="release-$version"
  if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null || [ -n "$(git ls-remote --heads origin "refs/heads/$branch")" ]; then
    fail "branch $branch already exists; merge or delete its pull request first"
  fi
  echo "main ($(short "$main")) is at $at_main. Step 1: bump to $version on branch $branch and open its pull request."
  for t in templates/*/package.json; do
    range=$(git show "$main:$t" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).dependencies["@intentius/sql-yodeler"]??""))')
    echo "  $t takes $PKG $range; once $version is on npm, check that range still takes it (^0.1.0 does not take 0.2.0)."
  done
  if [ "$dry" = 1 ]; then
    echo "Dry run: no branch, commit or pull request made."
    exit 0
  fi
  wt=$(mktemp -d "${TMPDIR:-/tmp}/yodel-release.XXXXXX")
  repo=$(pwd)
  trap 'cd "$repo" && git worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT
  git worktree add --quiet -b "$branch" "$wt" "$main"
  cd "$wt"
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    pkg.version = process.argv[1];
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  ' "$version"
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
  git add package.json package-lock.json
  git commit --quiet -m "chore: release $version"
  git push --quiet -u origin "$branch"
  gh pr create --base main --head "$branch" --title "chore: release $version" --body "Bumps $PKG to $version in package.json and package-lock.json.

Once this is merged and the \`ci\` and \`claims\` runs on its commit on main are green, \`npm run release -- $version\` tags that commit $tag, and the publish workflow publishes it."
  exit 0
fi

# --- 2. The tag, on a green commit of main -----------------------------------
# verdict <workflow> <sha>: "status conclusion url" of the newest push run on main, or nothing.
verdict() {
  gh api -X GET "repos/{owner}/{repo}/actions/workflows/$1/runs" \
    -f head_sha="$2" -f event=push -f branch=main -f per_page=1 \
    --jq '.workflow_runs[0] // empty | "\(.status) \(.conclusion // "-") \(.html_url)"'
}
# green <sha>: both workflows' newest runs concluded success; says why not on stderr.
green() {
  local wf v status conclusion url ok=0
  for wf in "${WORKFLOWS[@]}"; do
    v=$(verdict "$wf" "$1") || fail "gh api failed, so CI on $(short "$1") cannot be checked"
    if [ -z "$v" ]; then
      echo "  $(short "$1"): no ${wf%.yml} run on main" >&2
      ok=1
      continue
    fi
    read -r status conclusion url <<<"$v"
    if [ "$status" != "completed" ]; then
      echo "  $(short "$1"): ${wf%.yml} is $status $url" >&2
      ok=1
    elif [ "$conclusion" != "success" ]; then
      echo "  $(short "$1"): ${wf%.yml} concluded $conclusion $url" >&2
      ok=1
    else
      echo "  $(short "$1"): ${wf%.yml} green $url" >&2
    fi
  done
  return "$ok"
}

if [ -n "$commit" ]; then
  sha=$(git rev-parse --verify --quiet "$commit^{commit}") || fail "\"$commit\" is not a commit here"
  git merge-base --is-ancestor "$sha" "$main" || fail "$(short "$sha") is not on origin/main"
  [ "$(version_at "$sha")" = "$version" ] || fail "$(short "$sha") is at $(version_at "$sha"), not $version"
  green "$sha" || fail "$(short "$sha") is not green on both ci and claims"
else
  sha=""
  for c in $(git rev-list --first-parent --max-count 100 "$main"); do
    # Commits before the bump carry another version: nothing older can be the release.
    [ "$(version_at "$c")" = "$version" ] || break
    if green "$c"; then
      sha="$c"
      break
    fi
  done
  [ -n "$sha" ] || fail "no commit on main at $version has both ci and claims green yet; wait for the runs, or fix main"
fi

echo "Tag $tag on $(short "$sha") ($(git log -1 --format=%s "$sha")); main is at $(short "$main")."
if [ "$dry" = 1 ]; then
  echo "Dry run: no tag made or pushed."
  exit 0
fi
git tag -a "$tag" -m "$tag" "$sha"
if ! git push --quiet origin "refs/tags/$tag"; then
  git tag -d "$tag" >/dev/null
  fail "pushing $tag failed; the local tag is deleted"
fi
echo "Pushed $tag. The publish workflow publishes $PKG@$version: gh run list --workflow publish.yml"
