#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_PARENT="$(cd "${SRC_ROOT}/.." && pwd)"
WORKSPACE_NAME="$(basename "${SRC_ROOT}")"

OUT_DIR="${SRC_PARENT}/${WORKSPACE_NAME}-public"
BRANCH_NAME="public-main"
REMOTE_URL="${PUBLIC_REMOTE_URL:-}"
COMMIT_MESSAGE="chore(release): prepare public workspace snapshot"
PUSH_AFTER_COMMIT=0

usage() {
  cat <<EOF
Usage:
  bash scripts/create_public_workspace_repo.sh [options]

Options:
  --out-dir PATH           Export to PATH. Default: ${OUT_DIR}
  --branch NAME            Publish branch name. Default: ${BRANCH_NAME}
  --remote URL             Set origin to URL before pushing
  --commit-message TEXT    Commit message for the public snapshot
  --push                   Push to origin after commit
  -h, --help               Show this help message

Examples:
  bash scripts/create_public_workspace_repo.sh
  bash scripts/create_public_workspace_repo.sh --remote git@github.com:you/repo.git --push
  bash scripts/create_public_workspace_repo.sh --out-dir ../miniopencodev2-public --branch public-main
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --branch)
      BRANCH_NAME="$2"
      shift 2
      ;;
    --remote)
      REMOTE_URL="$2"
      shift 2
      ;;
    --commit-message)
      COMMIT_MESSAGE="$2"
      shift 2
      ;;
    --push)
      PUSH_AFTER_COMMIT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${PUSH_AFTER_COMMIT}" -eq 1 && -z "${REMOTE_URL}" ]]; then
  echo "--push requires --remote or PUBLIC_REMOTE_URL" >&2
  exit 1
fi

if [[ "${OUT_DIR}" == "${SRC_ROOT}" ]]; then
  echo "Refusing to export into the source workspace itself: ${OUT_DIR}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

RSYNC_EXCLUDES=(
  --exclude='.git'
  --exclude='node_modules'
  --exclude='meta_logs'
  --exclude='project_logs'
  --exclude='audit'
  --exclude='checkpoints'
  --exclude='dist'
  --exclude='.claude'
  --exclude='*.local.json'
  --exclude='*.tmp'
  --exclude='*.temp'
  --exclude='*.log'
  --exclude='.tmp-vitest-report.json'
  --exclude='meta_state.json'
  --exclude='project_state.json'
)

EXPORT_DIRS=(
  "docs"
  "harness_meta"
  "scripts"
  "target_project"
)

EXPORT_FILES=(
  "CLAUDE.md"
  "PUBLIC_RELEASE.md"
  "README.md"
)

sync_dir() {
  local relative_path="$1"
  local source_dir="${SRC_ROOT}/${relative_path}"
  local target_dir="${OUT_DIR}/${relative_path}"

  if [[ -d "${source_dir}" ]]; then
    mkdir -p "${target_dir}"
    rsync -a --delete "${RSYNC_EXCLUDES[@]}" "${source_dir}/" "${target_dir}/"
    return
  fi

  rm -rf "${target_dir}"
  echo "Skipping missing directory: ${source_dir}"
}

sync_file() {
  local relative_path="$1"
  local source_file="${SRC_ROOT}/${relative_path}"
  local target_file="${OUT_DIR}/${relative_path}"

  if [[ -f "${source_file}" ]]; then
    mkdir -p "$(dirname "${target_file}")"
    cp "${source_file}" "${target_file}"
    return
  fi

  rm -f "${target_file}"
}

ensure_branch() {
  if git -C "${OUT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "${OUT_DIR}" checkout -B "${BRANCH_NAME}" >/dev/null
    return
  fi

  git -C "${OUT_DIR}" init -b "${BRANCH_NAME}" >/dev/null
}

echo "Preparing public workspace export at: ${OUT_DIR}"

ensure_branch

for relative_dir in "${EXPORT_DIRS[@]}"; do
  sync_dir "${relative_dir}"
done

for relative_file in "${EXPORT_FILES[@]}"; do
  sync_file "${relative_file}"
done

cat > "${OUT_DIR}/.gitignore" <<'EOF'
.DS_Store
.claude/
node_modules/
meta_logs/
project_logs/
**/node_modules/
**/meta_logs/
**/project_logs/
**/audit/
**/checkpoints/
**/*.local.json
**/*.tmp
**/*.temp
**/*.log
**/.tmp-vitest-report.json
**/meta_state.json
**/project_state.json
EOF

find "${OUT_DIR}" -mindepth 1 -type d -name '.git' ! -path "${OUT_DIR}/.git" -prune -exec rm -rf {} +

find "${OUT_DIR}" -type f \( \
  -name '*.md' -o \
  -name '*.json' -o \
  -name '*.jsonl' -o \
  -name '*.ts' -o \
  -name '*.js' -o \
  -name '*.txt' \
\) -exec perl -0pi -e '
  s/sk-cp-[A-Za-z0-9_-]+/{{MINIMAX_API_KEY}}/g;
  s/sk-cp-\.\.\./{{MINIMAX_API_KEY}}/g;
  s#songxw17\@qq\.com#<redacted-email>#g;
  s#/Users/[^/[:space:]`"]+(?:/[^/[:space:]`"]+)*#<workspace-path>#g;
' {} +

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Public Release}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-public-release@example.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-${GIT_AUTHOR_NAME}}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-${GIT_AUTHOR_EMAIL}}"

git -C "${OUT_DIR}" add -A .

if git -C "${OUT_DIR}" diff --cached --quiet; then
  echo "No public snapshot changes to commit."
else
  git -C "${OUT_DIR}" commit -m "${COMMIT_MESSAGE}" >/dev/null
fi

if [[ -n "${REMOTE_URL}" ]]; then
  if git -C "${OUT_DIR}" remote get-url origin >/dev/null 2>&1; then
    git -C "${OUT_DIR}" remote set-url origin "${REMOTE_URL}"
  else
    git -C "${OUT_DIR}" remote add origin "${REMOTE_URL}"
  fi
fi

if [[ "${PUSH_AFTER_COMMIT}" -eq 1 ]]; then
  git -C "${OUT_DIR}" push -u origin "${BRANCH_NAME}"
fi

echo
echo "Public workspace repo is ready."
echo "Output directory : ${OUT_DIR}"
echo "Branch name      : ${BRANCH_NAME}"

if [[ "${PUSH_AFTER_COMMIT}" -eq 1 ]]; then
  echo "Push status      : pushed to origin/${BRANCH_NAME}"
elif [[ -n "${REMOTE_URL}" ]]; then
  echo "Remote origin    : ${REMOTE_URL}"
  echo "Next step        : git -C ${OUT_DIR} push -u origin ${BRANCH_NAME}"
else
  echo "Next steps:"
  echo "  git -C ${OUT_DIR} remote add origin <your-github-repo>"
  echo "  git -C ${OUT_DIR} push -u origin ${BRANCH_NAME}"
fi
