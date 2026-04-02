#!/bin/bash
# Netlify calls this to decide whether to build.
# Exit 0 = skip build, exit 1 = proceed with build.
# Only build if files in this site's directory changed.
git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- .
