#!/bin/bash

# TokenPilot Quick Start Script
# This script helps you verify and start everything needed for TokenPilot

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     TokenPilot Quick Start             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check if Bifrost directory exists
if [ ! -d "/Users/thushara/Desktop/TokenPilot-Bifrost" ]; then
    echo -e "${RED}✗ Bifrost directory not found${NC}"
    echo "  Expected: /Users/thushara/Desktop/TokenPilot-Bifrost"
    exit 1
fi

echo -e "${GREEN}✓ Bifrost directory found${NC}"

# Check if .env has Gemini key
if grep -q "GOOGLE_API_KEY=AQ\." "/Users/thushara/Desktop/TokenPilot-Bifrost/.env" 2>/dev/null; then
    echo -e "${GREEN}✓ Gemini API key configured${NC}"
else
    echo -e "${YELLOW}⚠ Gemini API key not found in .env${NC}"
fi

# Check if Ollama is installed
if command -v ollama &> /dev/null; then
    echo -e "${GREEN}✓ Ollama installed${NC}"
    
    # Check if Ollama is running
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Ollama is running${NC}"
        
        # Check which models are installed
        MODELS=$(ollama list 2>/dev/null | tail -n +2 | awk '{print $1}' | grep -E "llama3.2|qwen2.5-coder|deepseek-coder" || echo "")
        if [ -n "$MODELS" ]; then
            echo -e "${GREEN}✓ Ollama models installed:${NC}"
            echo "$MODELS" | sed 's/^/    /'
        else
            echo -e "${YELLOW}⚠ No configured Ollama models found${NC}"
            echo -e "${YELLOW}  Run: ollama pull llama3.2${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ Ollama not running (this is optional)${NC}"
        echo -e "${YELLOW}  Run: ollama serve${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Ollama not installed (optional for local models)${NC}"
    echo -e "${YELLOW}  Install from: https://ollama.com${NC}"
fi

echo ""
echo -e "${BLUE}─────────────────────────────────────────${NC}"
echo -e "${BLUE}Next Steps:${NC}"
echo ""
echo -e "${GREEN}1. Start Bifrost:${NC}"
echo "   cd /Users/thushara/Desktop/TokenPilot-Bifrost"
echo "   ./start.sh"
echo ""
echo -e "${GREEN}2. Install Extension:${NC}"
echo "   - Open Cursor"
echo "   - Extensions → Install from VSIX"
echo "   - Select: tokenpilot-0.1.0.vsix"
echo ""
echo -e "${GREEN}3. Configure Cursor Settings:${NC}"
echo '   {"tokenpilot.bifrostUrl": "http://localhost:8080"}'
echo ""
echo -e "${GREEN}4. Open Dashboard:${NC}"
echo "   http://localhost:4000"
echo "   (admin / hackathon2024)"
echo ""
echo -e "${BLUE}─────────────────────────────────────────${NC}"
echo ""
echo "Run './start-bifrost.sh' to start Bifrost automatically"
echo "See COMPLETE_SETUP_GUIDE.md for detailed instructions"
echo ""
