#!/usr/bin/env bash
# Builds the patched Zitadel Login V2 image (OpenSpec change
# remove-password-setup-from-hosted-login, design D3).
#
#   zitadel-login/build.sh <image-ref>
#
# Checks out zitadel/zitadel at UPSTREAM_TAG, applies patches/*.patch with
# `git am`, builds the standalone app with the upstream `build` target, runs
# the login app's unit tests and builds the image with the upstream
# Dockerfile, tagged <image-ref>, for linux/amd64. It never pushes.
#
# Every step that shapes the image lives here, so the image tag
# `<UPSTREAM_TAG>-lm.<first 12 chars of git rev-parse HEAD:zitadel-login>`
# covers the build logic too. Needs git, Node.js 22 with corepack, and Docker.
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "usage: $0 <image-ref>" >&2
	exit 2
fi
image=$1

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
upstream_tag=$(tr -d '[:space:]' <"$here/UPSTREAM_TAG")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch "$upstream_tag" \
	https://github.com/zitadel/zitadel.git "$work/zitadel"
cd "$work/zitadel"
git -c user.name=zitadel-login-build -c user.email=zitadel-login-build@liverty-music.app \
	am --quiet "$here"/patches/*.patch

# No Nx Cloud (upstream's workspace has an nxCloudId) and no daemon in CI.
export NX_NO_CLOUD=true NX_DAEMON=false COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Upstream's Nx targets call `pnpm` directly: put corepack's pnpm (the
# version in upstream's packageManager) on PATH for this build only.
mkdir "$work/bin"
corepack enable --install-directory "$work/bin" pnpm
export PATH="$work/bin:$PATH"
pnpm install --frozen-lockfile
pnpm nx run --nxBail @zitadel/login:build --outputStyle=static
# The login app's unit tests (upstream's `test-unit` target, run directly so
# the report is not buried in the tests' console output).
pnpm --dir apps/login exec vitest --run --silent

# The upstream `pack` target runs this docker build with a hard-coded tag
# (apps/login/project.json); run it directly to tag for Artifact Registry.
docker build --platform linux/amd64 -f apps/login/Dockerfile -t "$image" apps/login
