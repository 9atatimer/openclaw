#!/usr/bin/env bash
# Build + publish @9atatimer/openclaw to GitHub Packages from a local machine.
# Invoked by the pre-push hook on push to feature/telegram-group-memory and
# usable by hand for ad hoc publishes.
#
# Auth resolution order:
#   1. $GH_PACKAGES_TOKEN env (explicit override)
#   2. `gh auth token` (must have write:packages scope; refresh with
#      `gh auth refresh -h github.com -s write:packages` if missing)
#
# Bypass with SKIP_PRIVATE_PUBLISH=1 when invoking the caller (pre-push or
# direct), e.g. SKIP_PRIVATE_PUBLISH=1 git push origin feature/telegram-group-memory.

set -euo pipefail

PUBLISH_SHA="${1:-$(git rev-parse HEAD)}"
PRIVATE_NPM_SCOPE="${PRIVATE_NPM_SCOPE:-@9atatimer}"
PRIVATE_NPM_REGISTRY="${PRIVATE_NPM_REGISTRY:-https://npm.pkg.github.com}"
PRIVATE_NPM_DIST_TAG="${PRIVATE_NPM_DIST_TAG:-preprod}"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "publish-private-package: working tree is dirty; commit or stash before publishing." >&2
  exit 1
fi

if [[ -n "${GH_PACKAGES_TOKEN:-}" ]]; then
  TOKEN="${GH_PACKAGES_TOKEN}"
elif command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi

if [[ -z "${TOKEN:-}" ]]; then
  cat >&2 <<'EOF'
publish-private-package: no GH Packages token available.
  Either set GH_PACKAGES_TOKEN, or ensure `gh auth token` returns one with
  write:packages scope:
    gh auth refresh -h github.com -s write:packages
EOF
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  if ! gh auth status 2>&1 | grep -q "write:packages"; then
    cat >&2 <<'EOF'
publish-private-package: gh auth token is missing write:packages scope.
Run:
  gh auth refresh -h github.com -s write:packages
EOF
    exit 1
  fi
fi

scratch_dir="$(mktemp -d)"
NPMRC="${scratch_dir}/npmrc"
PACKAGE_BACKUP="${scratch_dir}/package.json.bak"
cp package.json "$PACKAGE_BACKUP"

cleanup() {
  if [[ -f "$PACKAGE_BACKUP" ]]; then
    cp "$PACKAGE_BACKUP" package.json
  fi
  rm -rf "$scratch_dir"
}
trap cleanup EXIT

cat > "$NPMRC" <<EOF
//npm.pkg.github.com/:_authToken=${TOKEN}
${PRIVATE_NPM_SCOPE}:registry=${PRIVATE_NPM_REGISTRY}
EOF
chmod 600 "$NPMRC"

echo "publish-private-package: typechecking..."
OPENCLAW_LOCAL_CHECK=0 OPENCLAW_SKIP_BUNDLED_RUNTIME_DEPS="*" pnpm tsgo:prod

echo "publish-private-package: building..."
OPENCLAW_LOCAL_CHECK=0 OPENCLAW_SKIP_BUNDLED_RUNTIME_DEPS="*" pnpm build

echo "publish-private-package: ui:build..."
OPENCLAW_LOCAL_CHECK=0 pnpm ui:build

SHA_SHORT="$(git rev-parse --short=8 "$PUBLISH_SHA")"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
BUILD_LABEL="${PRIVATE_NPM_DIST_TAG}.${TIMESTAMP}.git-${SHA_SHORT}"

PRIVATE_NPM_SCOPE="$PRIVATE_NPM_SCOPE" \
PRIVATE_NPM_DIST_TAG="$PRIVATE_NPM_DIST_TAG" \
PRIVATE_NPM_BUILD_LABEL="$BUILD_LABEL" \
PRIVATE_NPM_REGISTRY="$PRIVATE_NPM_REGISTRY" \
node scripts/rewrite-package-for-private-publish.mjs

echo "publish-private-package: publishing..."
NPM_CONFIG_USERCONFIG="$NPMRC" pnpm publish \
  --no-git-checks \
  --ignore-scripts \
  --tag "$PRIVATE_NPM_DIST_TAG" \
  --registry "$PRIVATE_NPM_REGISTRY"

PUBLISHED_NAME="$(node -p "require('./package.json').name")"
PUBLISHED_VERSION="$(node -p "require('./package.json').version")"

echo
echo "publish-private-package: published"
echo "  package : ${PUBLISHED_NAME}"
echo "  version : ${PUBLISHED_VERSION}"
echo "  dist-tag: ${PRIVATE_NPM_DIST_TAG}"
echo "  registry: ${PRIVATE_NPM_REGISTRY}"
