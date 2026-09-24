#!/bin/bash
# Builds src/*.html + src/*.js into one self-contained dist/meridian-pos.html
# Usage: ./build.sh
set -e
cd "$(dirname "$0")"

mkdir -p dist

# 00-plemmo-api.js is concatenated first (right after the shell opens the
# <script>) so window.PlemmoAPI is available to every later file. It is a
# self-contained IIFE with no dependency on later helpers.
{
  cat src/01-shell.html \
      src/00-plemmo-api.js \
      src/02-data.js \
      src/03-app-shell.js \
      src/04-register-kitchen.js \
      src/05-backoffice.js \
      src/06-dashboard-ai-kiosk.js
  printf '\n</script>\n</body>\n</html>\n'
} > dist/meridian-pos.html

# Optional syntax check if Node is available
if command -v node >/dev/null 2>&1; then
  cat src/00-plemmo-api.js src/02-data.js src/03-app-shell.js src/04-register-kitchen.js \
      src/05-backoffice.js src/06-dashboard-ai-kiosk.js > /tmp/meridian-check.js
  node --check /tmp/meridian-check.js && echo "JS syntax OK"
fi

echo "Built dist/meridian-pos.html ($(wc -c < dist/meridian-pos.html) bytes)"
