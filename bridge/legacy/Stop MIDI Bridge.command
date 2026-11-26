#!/bin/bash
# Double-click this in Finder to stop the MIDI bridge and hand the keyboard back.
# Use it before opening another DAW that drives the S88's DAW mode, so the two
# are not both talking to the keyboard at once.
#
# This stops the bridge whether it was started from "Start MIDI Bridge.command",
# from a terminal, or in the background with no window to close.

found=$(pgrep -x s88-bridge)

if [ -z "$found" ]; then
  echo "The MIDI bridge is not running — nothing to stop."
else
  echo "Stopping the MIDI bridge (pid $(echo "$found" | tr '\n' ' ' | sed 's/ $//'))…"
  pkill -x s88-bridge

  # Give it a moment to close its MIDI ports and its listening socket, then insist.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x s88-bridge >/dev/null || break
    sleep 0.2
  done
  if pgrep -x s88-bridge >/dev/null; then
    echo "It did not exit on request; forcing it."
    pkill -9 -x s88-bridge
    sleep 0.3
  fi

  if pgrep -x s88-bridge >/dev/null; then
    echo "Could not stop it. Check for an s88-bridge started by another user account."
  else
    echo "Stopped."
  fi
fi

echo
echo "The S88 is free for another DAW. Its screens may still show the last mixer"
echo "this add-on sent; the next DAW's handshake takes the keyboard over."
echo
read -r -p "Press return to close."
