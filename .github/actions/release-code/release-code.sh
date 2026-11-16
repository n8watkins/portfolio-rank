#!/usr/bin/env bash
# See action.yml. Runs in the checked-out repository.
#   CODE            release | checkout | an exact vX.Y.Z tag
#   RELEASE_REMOTE  the remote to read tags from (default origin; the test sets it)
set -euo pipefail

code="${CODE:-release}"
remote="${RELEASE_REMOTE:-origin}"
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
  # The newest plain vX.Y.Z tag by version, not by date.
  tag="$(git ls-remote --tags --refs "$remote" 'v[0-9]*' \
    | sed 's#.*refs/tags/##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V | tail -n 1 || true)"
  if [ -z "$tag" ]; then
    keep "No release tag yet: running the checked-out code until the first release is cut."
    exit 0
  fi
else
  tag="$code"
  if ! printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "::error::\"$tag\" is not a release tag (vX.Y.Z), \"release\" or \"checkout\"."
    exit 1
  fi
fi

git fetch --quiet --no-tags --depth 1 "$remote" "+refs/tags/$tag:refs/tags/$tag"
sha="$(git rev-parse "$tag^{commit}")"

# The working tree only: HEAD and the index stay on the checkout. A file the
# release does not have is removed, one main has since deleted comes back.
git restore --source="$sha" --worktree -- . ':(exclude)data' ':(exclude).github'

echo "tag=$tag" >> "$out"
echo "sha=$sha" >> "$out"
echo "Code: release $tag (${sha:0:7}). Data and workflows: the checkout (${head_sha:0:7})."
echo "Code: release \`$tag\` (${sha:0:7}). Data and workflows: the checkout (${head_sha:0:7})." >> "$summary"
