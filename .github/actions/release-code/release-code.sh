#!/usr/bin/env bash
# See action.yml. Runs in the checked-out repository.
#   CODE            release | checkout | an exact vX.Y.Z tag (empty means release)
#   RELEASE_REMOTE  the remote to read from (default origin; the test sets it)
set -euo pipefail

code="${CODE:-release}"
remote="${RELEASE_REMOTE:-origin}"
# The branch the Deploy workflow moves to a release once that release is live
# and smoke checked. Nothing else writes it.
pointer="production"
out="${GITHUB_OUTPUT:-/dev/null}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
head_sha="$(git rev-parse HEAD)"

keep() {
  echo "tag=" >> "$out"
  echo "sha=$head_sha" >> "$out"
  echo "::notice::$1"
  echo "Code and data: the checkout, ${head_sha:0:7} ($1)" >> "$summary"
}

if [ "$code" = "checkout" ]; then
  keep "Running the checked-out code, as asked."
  exit 0
fi

if [ "$code" = "release" ]; then
  # A network or sign-in failure stops here (set -e); only an answer that
  # lists no such branch means "no release has been deployed yet".
  listed="$(git ls-remote --heads "$remote" "refs/heads/$pointer")"
  if [ -z "$listed" ]; then
    keep "No release has been deployed yet: running the checked-out code until the first one is."
    exit 0
  fi
  git fetch --quiet --no-tags --depth 1 "$remote" "+refs/heads/$pointer:refs/remotes/release-code/$pointer"
  sha="$(git rev-parse "refs/remotes/release-code/$pointer^{commit}")"
  # Its tag, for the summary and for Sentry: the newest vX.Y.Z on that commit.
  tags="$(git ls-remote --tags "$remote" 'v[0-9]*')"
  tag="$(printf '%s\n' "$tags" \
    | awk -v sha="$sha" '$1 == sha { sub("^refs/tags/", "", $2); sub(/\^\{\}$/, "", $2); print $2 }' \
    | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
    | sort -V | tail -n 1)"
else
  tag="$code"
  if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "::error::The code to run must be \"release\", \"checkout\" or one release tag (vX.Y.Z)."
    exit 1
  fi
  git fetch --quiet --no-tags --depth 1 "$remote" "+refs/tags/$tag:refs/tags/$tag"
  sha="$(git rev-parse "$tag^{commit}")"
fi

# The working tree only: HEAD and the index stay on the checkout. A file the
# release does not have is removed, one main has since deleted comes back.
git restore --source="$sha" --worktree -- . ':(exclude)data' ':(exclude).github'

name="${tag:-unnamed}"
echo "tag=$tag" >> "$out"
echo "sha=$sha" >> "$out"
echo "Code: release $name (${sha:0:7}). Data and workflows: the checkout (${head_sha:0:7})."
echo "Code: release \`$name\` (${sha:0:7}). Data and workflows: the checkout (${head_sha:0:7})." >> "$summary"
