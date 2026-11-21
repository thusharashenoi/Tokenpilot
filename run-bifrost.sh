#!/bin/sh
set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.sample to .env and add the Gemini key." >&2
  exit 1
fi

exec docker run --rm -p 8080:8080 --env-file .env \
  -v "$(pwd)/bifrost/config.json:/app/data/config.json:ro" \
  maximhq/bifrost
