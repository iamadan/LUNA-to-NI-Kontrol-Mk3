#!/bin/bash
# Rebuild the bridge. Needs Xcode or the Command Line Tools (for swiftc).
set -e
cd "$(dirname "$0")"
swiftc -O -o s88-bridge S88Bridge.swift
echo "built: $(pwd)/s88-bridge"
