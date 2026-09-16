#!/bin/sh
cd -- "$(dirname -- "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ "$(uname -s)" = Darwin ]; then
  mkdir -p .launcher
  if [ ! -x .launcher/controller ] || [ scripts/launcher.swift -nt .launcher/controller ]; then
    swiftc scripts/launcher.swift -o .launcher/controller || exit 1
  fi
  exec .launcher/controller "$PWD"
else
  exec python3 scripts/launcher.py
fi
