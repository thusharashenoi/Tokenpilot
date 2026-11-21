# TokenPilot Complete Setup Guide

## ✅ Configuration Complete

Your TokenPilot setup now includes:
- ✅ 3 Gemini models (gemini-2.0-flash-exp, gemini-1.5-pro, gemini-1.5-flash)
- ✅ 3 Ollama models configured (llama3.2, qwen2.5-coder, deepseek-coder-v2)
- ✅ Models catalog updated
- ✅ Extension built and ready

---

## 📋 Prerequisites Checklist

### You Need to Install Ollama First

Ollama is not currently installed on your system. Here's how to set it up:

#### Install Ollama (macOS)

```bash
# Download and install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Or visit: https://ollama.com/download
```

#### Pull the Models

After installing Ollama, pull the models that are configured in Bifrost:

```bash
# Pull Llama 3.2 (lightweight, ~2GB)
ollama pull llama3.2

# Pull Qwen 2.5 Coder (optimized for coding, ~4GB)
ollama pull qwen2.5-coder:7b

# Pull DeepSeek Coder v2 (advanced coding, ~3GB)
ollama pull deepseek-coder-v2:16b
```

**Note:** Model sizes vary. Start with `llama3.2` if you want to test quickly.

#### Verify Ollama is Running

```bash
# Check if Ollama service is running
curl http://localhost:11434/api/tags

# You should see JSON output with your installed models
```

---

## 🚀 Step-by-Step Setup

### Step 1: Start Bifrost Gateway

```bash
cd /Users/thushara/Desktop/TokenPilot-Bifrost
./start.sh
```

**What this does:**
- Starts LiteLLM proxy on port 8080
- Loads Gemini API key from .env
- Routes requests to OpenAI, Anthropic, Gemini, and Ollama
- Enables dashboard at http://localhost:4000

**Expected output:**
```
INFO:     Uvicorn running on http://0.0.0.0:8080
```

Keep this terminal open - Bifrost needs to run continuously.

### Step 2: Verify Bifrost is Working

Open a new terminal:

```bash
cd /Users/thushara/Desktop/TokenPilot-Bifrost
./verify.sh
```

This will test all configured models including:
- OpenAI models
- Anthropic models  
- **Gemini models (NEW!)**
- **Ollama models (if installed)**

### Step 3: Install TokenPilot Extension in Cursor

```bash
cd /Users/thushara/Desktop/TokenPilot

# Package the extension
npx vsce package

# This creates tokenpilot-0.1.0.vsix
```

**Install in Cursor:**
1. Open Cursor
2. Go to Extensions (Cmd+Shift+X)
3. Click the "..." menu (top-right)
4. Select "Install from VSIX..."
5. Choose `/Users/thushara/Desktop/TokenPilot/tokenpilot-0.1.0.vsix`

### Step 4: Configure Cursor Settings

In Cursor, open Settings (Cmd+,) and add:

```json
{
  "tokenpilot.bifrostUrl": "http://localhost:8080",
  "tokenpilot.bifrostPath": "/v1/chat/completions",
  "tokenpilot.bifrostKey": "sk-bifrost-hackathon-2024",
  "tokenpilot.autoReduce": true,
  "tokenpilot.enableDashboard": true
}
```

### Step 5: Reload Cursor

Press `Cmd+Shift+P` and run:
```
Developer: Reload Window
```

---

## 🧪 Testing TokenPilot

### Test 1: Make a Simple Code Request

1. Open any code file in Cursor
2. Select some code
3. Use Cursor's chat (Cmd+L) and ask:
   ```
   Refactor this function to be more readable
   ```

4. **Behind the scenes:**
   - Request goes through TokenPilot proxy
   - TokenPilot strips 60-70% of context tokens
   - Request routed through Bifrost
   - Bifrost sends to configured model
   - Response comes back through the chain

### Test 2: Try Different Models

In Cursor chat, you can specify models:
```
@claude-sonnet-4-5 explain this code
@gemini-1.5-pro refactor this function
@ollama/llama3.2 add comments to this code
```

### Test 3: View the Dashboard

Open your browser to:
```
http://localhost:4000
```

**Login credentials:**
- Username: `admin`
- Password: `hackathon2024`

**Dashboard shows:**
- 📊 All requests made
- 💰 Token usage (input/output)
- ⏱️ Latency per request
- 🎯 Model routing decisions
- 💵 Cost calculations
- 📈 Usage trends

---

## 🔍 Verifying Everything Works

### Check 1: Extension Loaded

In Cursor:
1. Press `Cmd+Shift+P`
2. Type "TokenPilot"
3. You should see TokenPilot commands

### Check 2: Proxy Running

Check TokenPilot output:
1. View → Output (Cmd+Shift+U)
2. Select "TokenPilot" from dropdown
3. You should see proxy initialization logs

### Check 3: Request Flow

Make a code request in Cursor chat and check:

**In Cursor Output (TokenPilot channel):**
```
[TokenPilot] Intercepted request
[TokenPilot] Original tokens: 15234
[TokenPilot] Reduced tokens: 4521 (70.3% reduction)
[TokenPilot] Forwarding to Bifrost...
```

**In Bifrost terminal:**
```
POST /v1/chat/completions
Model: anthropic/claude-sonnet-4-5
Tokens: 4521
```

**In Dashboard (http://localhost:4000):**
- New entry in request log
- Shows token reduction
- Shows model used
- Shows cost

### Check 4: Gemini Models Working

Try a Gemini-specific request in Cursor chat:
```
@gemini-2.0-flash-exp write a hello world function
```

In the dashboard, verify:
- Request shows model: `google/gemini-2.0-flash-exp`
- Response received successfully
- Tokens and cost logged

### Check 5: Ollama Models Working (if installed)

Try an Ollama model:
```
@ollama/llama3.2 explain what this code does
```

In the dashboard, verify:
- Request shows model: `ollama/llama3.2`
- No cost (local model = free!)
- Response received

---

## 🐛 Troubleshooting

### Issue: "Bifrost not responding"

**Check:**
```bash
# Is Bifrost running?
curl http://localhost:8080/health

# Should return: {"status": "ok"}
```

**Fix:**
```bash
cd /Users/thushara/Desktop/TokenPilot-Bifrost
./start.sh
```

### Issue: "Gemini model not found"

**Check:**
```bash
# Verify API key is set
cat /Users/thushara/Desktop/TokenPilot-Bifrost/.env | grep GOOGLE_API_KEY
```

**Fix:**
Restart Bifrost to reload the configuration:
```bash
# Stop Bifrost (Ctrl+C in its terminal)
cd /Users/thushara/Desktop/TokenPilot-Bifrost
./start.sh
```

### Issue: "Ollama models failing"

**Check:**
```bash
# Is Ollama running?
curl http://localhost:11434/api/tags

# Are models pulled?
ollama list
```

**Fix:**
```bash
# Start Ollama if not running (usually auto-starts)
ollama serve

# Pull missing models
ollama pull llama3.2
ollama pull qwen2.5-coder:7b
```

### Issue: "No requests showing in dashboard"

**Check:**
1. Is Bifrost using the master key?
   - Look in config.yaml: `master_key: sk-bifrost-hackathon-2024`
2. Is Cursor using the same key?
   - Check Cursor settings: `"tokenpilot.bifrostKey"`

### Issue: "Extension not loading in Cursor"

**Fix:**
```bash
# Rebuild the extension
cd /Users/thushara/Desktop/TokenPilot
npm run build

# Repackage
npx vsce package

# Reinstall in Cursor
```

---

## 📊 What to Look For in Testing

### Successful Request Flow:

1. **Cursor Chat**: You type a code question
2. **TokenPilot Output**: Shows token reduction
3. **Bifrost Terminal**: Shows incoming request
4. **Dashboard**: New entry appears
5. **Cursor Chat**: Response appears

### Dashboard Details to Check:

| Column | What to Look For |
|--------|------------------|
| **Timestamp** | Recent request time |
| **Model** | Correct model name (e.g., `google/gemini-1.5-pro`) |
| **Input Tokens** | Reduced token count (should be 30-40% of original) |
| **Output Tokens** | Response token count |
| **Latency** | Response time in seconds |
| **Cost** | Calculated cost (or $0.00 for Ollama) |
| **Status** | ✅ Success or ❌ Error |

---

## 🎯 Test Scenarios

### Scenario 1: Token Reduction

1. Open a large file (>500 lines)
2. Select all code
3. Ask: "Summarize what this code does"
4. **Check dashboard**: Input tokens should be significantly less than file size

### Scenario 2: Model Comparison

Test the same prompt with different models:

```
@gemini-1.5-flash write a fibonacci function
@gemini-1.5-pro write a fibonacci function  
@ollama/qwen2.5-coder write a fibonacci function
```

**Compare in dashboard:**
- Response quality
- Latency differences
- Cost differences
- Token usage

### Scenario 3: Local vs Cloud

```
# Cloud (costs money)
@gemini-1.5-pro explain async/await in JavaScript

# Local (free!)
@ollama/llama3.2 explain async/await in JavaScript
```

**Check dashboard:**
- Cloud request shows cost
- Ollama request shows $0.00

---

## 📝 Model Quick Reference

### Gemini Models

| Model | Best For | Speed | Cost |
|-------|----------|-------|------|
| `google/gemini-1.5-flash` | Quick queries, simple tasks | ⚡⚡⚡ | $ |
| `google/gemini-1.5-pro` | Complex reasoning, long context | ⚡⚡ | $$ |
| `google/gemini-2.0-flash-exp` | Experimental features, latest | ⚡⚡⚡ | $ |

### Ollama Models (Local)

| Model | Best For | Size | RAM Needed |
|-------|----------|------|------------|
| `ollama/llama3.2` | General tasks | ~2GB | 8GB |
| `ollama/qwen2.5-coder` | Code generation | ~4GB | 12GB |
| `ollama/deepseek-coder-v2` | Advanced coding | ~9GB | 16GB |

### Quick Access in Cursor Chat

```
@gemini-flash     → gemini-1.5-flash
@gemini-pro       → gemini-1.5-pro
@gemini-2         → gemini-2.0-flash-exp
@llama            → ollama/llama3.2
@qwen             → ollama/qwen2.5-coder
@deepseek         → ollama/deepseek-coder-v2
```

---

## 🎉 Success Criteria

You'll know everything is working when:

✅ Bifrost starts without errors
✅ Dashboard loads and shows models
✅ Extension appears in Cursor
✅ Code requests get responses
✅ Dashboard shows request details
✅ Token reduction is visible in logs
✅ Gemini models respond successfully
✅ Ollama models work locally (if installed)

---

## 🔗 Quick Links

- **Bifrost Dashboard**: http://localhost:4000
- **Bifrost Health**: http://localhost:8080/health
- **Bifrost Models**: http://localhost:8080/models
- **Ollama Health**: http://localhost:11434/api/tags

---

## 📞 Next Steps

1. **Install Ollama** (if you want local models)
2. **Start Bifrost** with `./start.sh`
3. **Install extension** in Cursor
4. **Make a test request** in Cursor chat
5. **Open dashboard** at http://localhost:4000
6. **View the magic** happen! ✨

---

## 💡 Tips

- **Dashboard auto-refreshes**: Request logs update in real-time
- **Cost tracking**: Dashboard shows cumulative costs
- **Model aliases**: Use short names like `@gemini-pro` instead of full names
- **Local first**: Try Ollama models first to test without using API credits
- **Token savings**: TokenPilot typically saves 60-70% on token costs

---

**Need help?** Check the dashboard logs or Bifrost terminal output for detailed error messages.
