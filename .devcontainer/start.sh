#!/usr/bin/env bash
# Runs each time you connect to the Codespace. Starts the demo on port 8080
# unless an earlier connection already did.
cd "$(dirname "$0")/../demo"

if curl -fs -o /dev/null http://localhost:8080/; then
  echo "DLPCC demo is already running on port 8080."
  exit 0
fi
echo "Starting the DLPCC demo on port 8080. Open it on localhost; see the README."
exec npm start
