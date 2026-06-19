#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="${DIR}/key.pem"
EXTENSION_DIR="${DIR}/extension"
OUTPUT_FILE="${1:-${DIR}/extension.crx}"

if [ ! -f "$KEY_FILE" ]; then
  echo "No key.pem found at $KEY_FILE"
  echo "Generating a new signing key..."
  openssl genrsa -out "$KEY_FILE" 2048
  echo "Key generated at $KEY_FILE"
  echo ""
  echo "IMPORTANT: This key determines your extension ID."
  echo "Save it securely — reuse it for all future builds."
  echo "In CI, store the contents as the EXTENSION_PEM_KEY secret."
  echo ""
fi

pack_ok=false

# Chrome's own packer is the most reliable (produces CRX3 Chrome will accept)
if command -v google-chrome &>/dev/null; then
  echo "Using google-chrome --pack-extension..."
  google-chrome --headless=new --pack-extension="$EXTENSION_DIR" \
    --pack-extension-key="$KEY_FILE" --no-sandbox --disable-gpu 2>/dev/null || true
  if [ -f "${EXTENSION_DIR}.crx" ]; then
    mv "${EXTENSION_DIR}.crx" "$OUTPUT_FILE"
    rm -f "${EXTENSION_DIR}.pem"
    pack_ok=true
    echo "CRX packed with Chrome at $OUTPUT_FILE"
  else
    echo "Chrome pack failed, trying alternatives..."
  fi
fi

# Chromium (macOS Homebrew path)
if [ "$pack_ok" = false ] && [ -f /opt/homebrew/bin/chromium ]; then
  echo "Using chromium --pack-extension..."
  /opt/homebrew/bin/chromium --headless=new --pack-extension="$EXTENSION_DIR" \
    --pack-extension-key="$KEY_FILE" --no-sandbox --disable-gpu 2>/dev/null || true
  if [ -f "${EXTENSION_DIR}.crx" ]; then
    mv "${EXTENSION_DIR}.crx" "$OUTPUT_FILE"
    rm -f "${EXTENSION_DIR}.pem"
    pack_ok=true
    echo "CRX packed with Chromium at $OUTPUT_FILE"
  fi
fi

# Fallback: npx crx3
if [ "$pack_ok" = false ]; then
  if command -v npx &>/dev/null; then
    echo "Using npx crx3..."
    npx crx3 "$EXTENSION_DIR" -o "$OUTPUT_FILE" -p "$KEY_FILE"
    pack_ok=true
    echo "CRX packed with crx3 at $OUTPUT_FILE"
    echo ""
    echo "NOTE: crx3-made CRX files may not install on Chrome 128+."
    echo "For a reliable CRX, use Chrome's --pack-extension or install from source."
  else
    echo "ERROR: No packing tool available."
    echo "Install Node.js (for npx crx3) or use Chrome's --pack-extension."
    exit 1
  fi
fi
