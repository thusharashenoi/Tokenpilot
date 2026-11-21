#!/bin/bash

# Helper script to start Bifrost from TokenPilot directory

BIFROST_DIR="/Users/thushara/Desktop/TokenPilot-Bifrost"

if [ ! -d "$BIFROST_DIR" ]; then
    echo "❌ Bifrost directory not found: $BIFROST_DIR"
    exit 1
fi

echo "🚀 Starting Bifrost Gateway..."
cd "$BIFROST_DIR"
./start.sh
