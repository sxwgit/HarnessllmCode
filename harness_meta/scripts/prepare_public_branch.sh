#!/usr/bin/env bash

set -euo pipefail

BRANCH_NAME="${1:-public-main}"
COMMIT_MESSAGE="${2:-chore(release): prepare public snapshot}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CURRENT_BRANCH="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)"
WORKTREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/harness-public-branch-XXXXXX")"

if git -C "${REPO_ROOT}" show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
  echo "Branch '${BRANCH_NAME}' already exists. Delete it or choose another branch name."
  exit 1
fi

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$(git -C "${REPO_ROOT}" config user.name || echo Harness Release)}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$(git -C "${REPO_ROOT}" config user.email || echo harness-release@example.com)}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-${GIT_AUTHOR_NAME}}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-${GIT_AUTHOR_EMAIL}}"

cleanup() {
  git -C "${REPO_ROOT}" worktree remove --force "${WORKTREE_DIR}" >/dev/null 2>&1 || true
}

trap cleanup EXIT

echo "Using current working tree snapshot from branch '${CURRENT_BRANCH}' to prepare '${BRANCH_NAME}'."

git -C "${REPO_ROOT}" worktree add --detach "${WORKTREE_DIR}" HEAD >/dev/null

git -C "${WORKTREE_DIR}" checkout --orphan "${BRANCH_NAME}" >/dev/null
git -C "${WORKTREE_DIR}" rm -rf --cached . >/dev/null 2>&1 || true
git -C "${WORKTREE_DIR}" clean -fdx >/dev/null

mkdir -p "${WORKTREE_DIR}"

git -C "${REPO_ROOT}" ls-files -z --cached --others --exclude-standard | tar --null -T - -C "${REPO_ROOT}" -cf - | tar -xf - -C "${WORKTREE_DIR}"

git -C "${WORKTREE_DIR}" add .

if git -C "${WORKTREE_DIR}" diff --cached --quiet; then
  echo "No publishable changes found; branch '${BRANCH_NAME}' was not created."
  exit 1
fi

git -C "${WORKTREE_DIR}" commit -m "${COMMIT_MESSAGE}" >/dev/null

echo
echo "Created clean public branch: ${BRANCH_NAME}"
echo "Source branch snapshot   : ${CURRENT_BRANCH}"
echo "Push command             : git push <your-remote> ${BRANCH_NAME}"
