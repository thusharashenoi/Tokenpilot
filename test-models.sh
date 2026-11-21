#!/bin/bash

# Test script to verify all models are working through Bifrost

BIFROST_URL="http://localhost:8080"
API_KEY="sk-bifrost-hackathon-2024"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     TokenPilot Model Testing           ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check if Bifrost is running
if ! curl -s "$BIFROST_URL/health" > /dev/null 2>&1; then
    echo -e "${RED}✗ Bifrost is not running${NC}"
    echo "  Start Bifrost first: cd /Users/thushara/Desktop/TokenPilot-Bifrost && ./start.sh"
    exit 1
fi

echo -e "${GREEN}✓ Bifrost is running${NC}"
echo ""

# Test function
test_model() {
    local model=$1
    local name=$2
    
    echo -n "Testing $name ... "
    
    response=$(curl -s -X POST "$BIFROST_URL/v1/chat/completions" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d "{
            \"model\": \"$model\",
            \"messages\": [{\"role\": \"user\", \"content\": \"Say 'Hello from $name'\"}],
            \"max_tokens\": 50
        }" 2>&1)
    
    if echo "$response" | grep -q "Hello"; then
        echo -e "${GREEN}✓ Working${NC}"
        return 0
    elif echo "$response" | grep -q "error"; then
        error=$(echo "$response" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
        echo -e "${RED}✗ Error: $error${NC}"
        return 1
    else
        echo -e "${YELLOW}⚠ Unknown response${NC}"
        return 1
    fi
}

echo -e "${BLUE}Testing Gemini Models:${NC}"
test_model "google/gemini-2.0-flash-exp" "Gemini 2.0 Flash Exp"
test_model "google/gemini-1.5-pro" "Gemini 1.5 Pro"
test_model "google/gemini-1.5-flash" "Gemini 1.5 Flash"

echo ""
echo -e "${BLUE}Testing OpenAI Models:${NC}"
test_model "openai/gpt-4o-mini" "GPT-4o Mini"

echo ""
echo -e "${BLUE}Testing Anthropic Models:${NC}"
test_model "anthropic/claude-haiku-4-5" "Claude Haiku 4.5"

echo ""
echo -e "${BLUE}Testing Ollama Models (if available):${NC}"
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    test_model "ollama/llama3.2" "Llama 3.2 (local)"
else
    echo -e "${YELLOW}⚠ Ollama not running - skipping local models${NC}"
fi

echo ""
echo -e "${BLUE}─────────────────────────────────────────${NC}"
echo -e "${GREEN}Testing complete!${NC}"
echo ""
echo "View detailed logs at: http://localhost:4000"
echo "(Login: admin / hackathon2024)"
echo ""
