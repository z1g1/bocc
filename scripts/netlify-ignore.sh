#!/bin/sh
# Netlify `ignore` command (netlify.toml): exit 0 skips the build, exit 1 builds.
#
# `dev` and `main` deploy only from the "Migrate and deploy" GitHub workflow
# (.github/workflows/deploy.yml), which migrates Neon first and then calls a Netlify
# build hook. Netlify's own build on a push to those branches is skipped, so code never
# goes live before its migrations (issue #32, docs/backend/DEPLOYS.md). A build-hook
# build has INCOMING_HOOK_URL set. Deploy previews and other branches always build.
case "$BRANCH" in
  dev|main)
    if [ -n "$INCOMING_HOOK_URL" ]; then
      echo "netlify-ignore: build hook build of $BRANCH: building."
      exit 1
    fi
    echo "netlify-ignore: $BRANCH deploys from the Migrate and deploy workflow after migrating: skipping this build."
    exit 0
    ;;
esac
exit 1
