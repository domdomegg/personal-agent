#!/bin/sh
# Publish a file for Adam at https://<viewer host>/a/<name>: copies it into
# the viewer's artifacts directory (~/work/artifacts, served read-fresh) and
# prints the URL. Usage: scripts/publish-artifact.sh <file> [name]
set -eu
src=$1
name=${2:-$(basename "$src")}
dir=${AGENT_ARTIFACTS_DIR:-$HOME/work/artifacts}
mkdir -p "$dir"
cp "$src" "$dir/$name"
host=${AGENT_PUBLIC_HOST:-agent.home.adamjones.me}
printf 'https://%s/a/%s\n' "$host" "$(printf %s "$name" | sed 's/ /%20/g')"
