# TokenPilot

> Shrinks chat turns, attaches relevant tools, and routes to optimal models - saving 60-70% on LLM API costs.

## What It Does

TokenPilot is a VS Code extension that optimizes LLM requests before sending them to model providers:

- **Strips 60-70% of input tokens** - Removes fluff from prompts and system messages
- **Smart tool attachment** - Only sends tools relevant to the task
- **Intelligent routing** - Routes lookups to cheap models, edits to powerful models  
- **Cost tracking** - Per-user budgets and spending dashboards
- **Transparent proxy** - Works with Cursor and any OpenAI-compatible IDE

## Quick Start

### 1. Install Dependencies

```bash
npm install
npm run build
```

### 2. Set Up Bifrost Gateway

See [BIFROST.md](./BIFROST.md) for gateway setup instructions.

**TL;DR**:
```bash
cd ../TokenPilot-Bifrost
nano .env  # Add API keys
./start.sh
```

### 3. Configure Extension

In VS Code settings:

```json
{
  "tokenpilot.bifrostUrl": "http://localhost:8080",
  "tokenpilot.bifrostPath": "/v1/chat/completions",
  "tokenpilot.proxyEnabled": true,
  "tokenpilot.proxyPort": 8787,
  "tokenpilot.budgetUsd": 5.0
}
```

### 4. Configure Cursor

In Cursor settings:
- Set **OpenAI Base URL**: `http://127.0.0.1:8787/v1`
- Add models: `openai/gpt-4o-mini`, `openai/gpt-4o`, etc.

### 5. Test It

Send a prompt in Cursor and check the TokenPilot dashboard in VS Code sidebar.

## Architecture

```
User Prompt (verbose)
    ↓
NLP Condensing (removes filler, keeps requirements)
    ↓
Harness Stripping (drops examples, keeps safety rules)
    ↓
JEV Tool Attachment (only relevant tools)
    ↓
Model Routing (task-based selection)
    ↓
Bifrost Gateway (handles failovers)
    ↓
LLM Provider (OpenAI, Anthropic, etc.)
```

## Features

### Token Optimization

- **User Prompt Condensing**: Strips greetings, filler, commentary
- **Optional LLM Rewrite**: Uses local `qwen2.5:0.5b` for extra compression
- **Harness Stripping**: Removes examples, style guides, personality
- **Tool Schema Slimming**: Drops descriptions, keeps structure
- **Safety Preservation**: Always keeps approval rules

**Result**: 60-70% token reduction

### Smart Tool Attachment (JEV)

Instead of sending all tools, JEV analyzes the task and attaches only what's needed:

| Task Type | Tools Attached |
|-----------|----------------|
| Lookup | read, graph, search |
| Edit | read, graph, search, edit |
| Shell | read, edit, search, shell |
| Git | read, edit, git |

### Intelligent Routing

Routes to optimal model based on task complexity:

| Task | Model Tier | Example |
|------|-----------|---------|
| Lookup/Question | Small (cheap) | gpt-4o-mini, claude-haiku |
| Code Edit | Strong | gpt-4o, claude-sonnet |
| Design/Multi-file | Heavy | o1-mini, claude-opus |

### Cost Tracking

- Per-user spending limits
- Real-time dashboard
- Before/after token comparison
- Estimated vs actual costs

## Proxy Mode

TokenPilot runs a local proxy that intercepts OpenAI-compatible requests:

1. Cursor sends request to `http://127.0.0.1:8787/v1`
2. TokenPilot strips tokens
3. Forwards to Bifrost gateway
4. Returns response to Cursor

**Transparent** - works with any OpenAI-compatible client.

## Configuration

### Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tokenpilot.bifrostUrl` | `http://localhost:8080` | Bifrost gateway URL |
| `tokenpilot.proxyEnabled` | `true` | Enable local proxy |
| `tokenpilot.proxyPort` | `8787` | Proxy port |
| `tokenpilot.localUrl` | `http://localhost:11434` | Ollama URL (for rewrite) |
| `tokenpilot.rewriteModel` | `qwen2.5:0.5b` | Local rewrite model |
| `tokenpilot.budgetUsd` | `2.0` | Per-user spending limit |

See [package.json](./package.json) for all settings.

### Ollama Setup (Optional)

For prompt rewriting enhancement:

```bash
# Install Ollama
brew install ollama

# Pull rewrite model
ollama pull qwen2.5:0.5b

# Start Ollama
ollama serve
```

If Ollama isn't available, TokenPilot falls back to rule-based condensing.

## Development

### Build

```bash
npm run build        # Build once
npm run watch        # Watch mode
```

### Test

```bash
npm test            # Run all tests
npm run typecheck   # TypeScript check
```

### Package

```bash
vsce package
```

## Testing

See [TESTING_GUIDE.md](./TESTING_GUIDE.md) for complete testing instructions.

**Quick test**:
```bash
# Start Bifrost
cd ../TokenPilot-Bifrost && ./start.sh

# Verify
./verify.sh
```

## Expected Results

### Token Savings

| Task Type | Baseline | Stripped | Saved |
|-----------|----------|----------|-------|
| Simple lookup | 800 | 250 | 69% |
| Code edit | 1,200 | 450 | 63% |
| Multi-file | 2,000 | 800 | 60% |

### Cost Savings

| Model | Without | With | Saved |
|-------|---------|------|-------|
| GPT-4o | $0.030/turn | $0.011/turn | 63% |
| Claude Sonnet | $0.018/turn | $0.007/turn | 61% |

**Monthly savings for team of 10**: ~$975 ($11,700/year)

## Project Structure

```
src/
├── core/
│   ├── optimize.ts          # Main optimization pipeline
│   ├── userPrompt.ts        # User prompt condensing
│   ├── harness.ts           # Harness stripping
│   ├── jev.ts               # Tool attachment (JEV)
│   ├── route.ts             # Model routing logic
│   ├── bifrost.ts           # Gateway communication
│   ├── reduce.ts            # Request reduction
│   └── proxy.ts             # Proxy helpers
├── extension.ts             # VS Code extension entry
├── session.ts               # Session management
└── proxyServer.ts           # HTTP proxy server

test/                        # Unit tests
dist/                        # Build output
```

## Key Algorithms

### User Prompt Condensing

1. **Rule-based stripping**:
   - Remove greetings, filler, commentary
   - Keep constraints, paths, function calls, errors
   
2. **Optional LLM rewrite**:
   - Send to local `qwen2.5:0.5b`
   - Further compress while preserving requirements
   
3. **Safety verification**:
   - Check all requirements preserved
   - Fall back to rule-based if anything dropped

### Harness Stripping

1. **Section removal**: Drop examples, style guides, personality
2. **Constraint extraction**: Keep lines with "must", "never", "approval"
3. **Token budgeting**: Limit to 420 tokens max
4. **Safety injection**: Always add approval rules if missing

### JEV Tool Attachment

1. **Task classification**: Lookup vs Edit vs Reason
2. **Keyword detection**: Shell, git, web mentions
3. **Tag-based filtering**: Only attach tools with matching tags
4. **Explicit override**: Always keep explicitly mentioned tools

## Contributing

This is a hackathon project. Feel free to fork and extend!

## License

MIT

## Credits

- Built with LiteLLM for Bifrost gateway
- Uses Ollama for local prompt rewriting
- Integrates with VS Code extension API
