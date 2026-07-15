#!/usr/bin/env bash
set -e

# 1. Define the config folder where OnchainOS looks for credentials
# In your Dockerfile, the active user is 'root', so this evaluates to /root/.onchainos
ONCHAINOS_DIR="/root/.onchainos"
echo "Target configuration folder: $ONCHAINOS_DIR"

# 2. Create the configuration directory
mkdir -p "$ONCHAINOS_DIR"

# 3. Map the Secret Files from Render into OnchainOS
if [ -d "/etc/secrets" ]; then
    echo "Found /etc/secrets directory. Mapping credential files..."
    
    # Copy your secret files to the target directory
    cp /etc/secrets/session.json "$ONCHAINOS_DIR/session.json"
    cp /etc/secrets/wallets.json "$ONCHAINOS_DIR/wallets.json"
    
    echo "OnchainOS credentials mapped successfully!"
else
    echo "ERROR: /etc/secrets directory does not exist! Did you forget to add the Secret Files in Render?"
    exit 1
fi