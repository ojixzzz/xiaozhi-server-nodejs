#!/bin/sh
# Optional evidence check; does not download or modify firmware and is not npm test.
set -eu
if [ "$#" -ne 1 ]; then
  echo 'Usage: sh scripts/firmware-audit/check-sample.sh /path/to/pinned/xiaozhi-esp32' >&2
  exit 2
fi
firmware=$1
expected=0d576d3d4c049c6f55eaf879725dc23e516511b4
[ "$(git -C "$firmware" rev-parse HEAD)" = "$expected" ] || { echo 'Firmware commit differs from audited pin' >&2; exit 2; }
git -C "$firmware" diff --quiet HEAD -- main/audio/demuxer/ogg_demuxer.cc main/audio/demuxer/ogg_demuxer.h || { echo 'Parser files differ from pinned source' >&2; exit 2; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
"${CXX:-c++}" -std=c++20 -I"$here" -I"$firmware/main/audio/demuxer" \
  "$here/sample_parser.cc" "$firmware/main/audio/demuxer/ogg_demuxer.cc" -o "$temporary/sample-parser"
"$temporary/sample-parser" "$repo/notification-audio/sample-chime.ogg"
