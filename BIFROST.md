# Bifrost Gateway Setup

TokenPilot requires a Bifrost-compatible gateway to route requests to LLM providers.

## Quick Setup

The Bifrost setup files are located **outside this repository** to keep configuration separate from code.

### Location

```
/Users/thushara/Desktop/TokenPilot-Bifrost/
```

### Setup Steps

1. **Navigate to Bifrost directory**:
   ```bash
   cd /Users/thushara/Desktop/TokenPilot-Bifrost
   ```

2. **Add your API keys**:
   ```bash
   nano .env
   ```
   Add your OpenAI and Anthropic keys.

3. **Start Bifrost**:
   ```bash
   ./start.sh
   ```

4. **Verify setup**:
   ```bash
   ./verify.sh
   ```

### Full Documentation

See `TokenPilot-Bifrost/README.md` for complete setup instructions.

## What is Bifrost?

Bifrost is an AI gateway that:
- Routes requests to multiple LLM providers (OpenAI, Anthropic, etc.)
- Handles automatic failovers
- Tracks usage and spending
- Provides a unified OpenAI-compatible API

## TokenPilot Configuration

Once Bifrost is running, configure TokenPilot in VS Code settings:

```json
{
  "tokenpilot.bifrostUrl": "http://localhost:8080",
  "tokenpilot.bifrostPath": "/v1/chat/completions",
  "tokenpilot.bifrostKey": "sk-bifrost-hackathon-2024"
}
```

## Alternative: Use Without Bifrost

You can point TokenPilot directly to OpenAI or use OpenRouter:

### Direct OpenAI
```json
{
  "tokenpilot.bifrostUrl": "https://api.openai.com",
  "tokenpilot.bifrostPath": "/v1/chat/completions",
  "tokenpilot.bifrostKey": "sk-your-openai-key"
}
```

### OpenRouter
```json
{
  "tokenpilot.bifrostUrl": "https://openrouter.ai/api",
  "tokenpilot.bifrostPath": "/v1/chat/completions",
  "tokenpilot.bifrostKey": "sk-or-v1-your-key"
}
```

## Architecture

```
Cursor → TokenPilot Proxy → Token Stripping → Bifrost → LLM Providers
```

- **TokenPilot** strips 60-70% of input tokens
- **Bifrost** routes to optimal model and handles failovers
- **Result**: 60-70% cost savings with same quality
