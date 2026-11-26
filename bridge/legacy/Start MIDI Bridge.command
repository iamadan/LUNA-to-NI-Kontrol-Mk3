#!/bin/bash
# Double-click this in Finder to start the MIDI bridge the add-on needs.
# Leave the window open while you use the add-on; close it or press Ctrl-C to stop.
cd "$(dirname "$0")" || exit 1
if [ ! -x bridge/s88-bridge ]; then
  echo "Building the bridge for the first time…"
  ( cd bridge && swiftc -O -o s88-bridge S88Bridge.swift ) || {
    echo "Build failed. Xcode or the Command Line Tools are needed once, to compile it."
    read -r -p "Press return to close."
    exit 1
  }
fi
echo "Starting s88-bridge. Keep this window open."
exec ./bridge/s88-bridge "$@"
