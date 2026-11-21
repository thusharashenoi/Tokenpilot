# TokenPilot

TokenPilot is a VS Code extension that sends a coding chat through [Bifrost](https://github.com/maximhq/bifrost) and compares two routes on the same prompt:

- **Bare Bifrost (Cursor harness)** sends the full synthetic Cursor prompt and its tool list.
- **Custom harness** rewrites the task with a local Ollama model, packs large JSON as TOON, and sends a short coding prompt. The chat shows whether that rewrite was kept.

The right-hand window for the demo is a small shop checkout in a sibling folder, `tokenpilot-test`. Guest checkout is already implemented there. A good custom reply says no edit is required and names `charge(card, amount, guest)`.

## What you need

- Node.js 20 or newer
- VS Code 1.85 or newer
- Docker, running
- [Ollama](https://ollama.com)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

Lay the folders out like this. The debugger opens the second one.

```
Hackathons/
  GlobalAIHack26/     this repo
  tokenpilot-test/    sample shop the demo reads
```

## 1. Install the extension

From this repo:

```sh
npm install
npm run build
```

`npm test` typechecks and runs the suite.

## 2. Add the Gemini key

```sh
cp .env.sample .env
```

Put the key in `GEMINI_API_KEY`. Leave the model lines as `gemini/gemini-3.5-flash-lite`. Do not commit `.env`.

## 3. Start Ollama

Ollama must be running (`ollama list` should print). Pull the rewrite model:

```sh
ollama pull qwen2.5:1.5b
```

The extension calls this model at `http://127.0.0.1:11434`. A short greeting skips it. A longer prompt is sent to it, and the draft is kept only when every requirement survives. Otherwise a local condenser is used and the chat says `draft dropped`.

## 4. Start Bifrost

In a terminal that can stay open:

```sh
./run-bifrost.sh
```

That publishes `http://localhost:8080` and mounts `bifrost/config.json`. The UI is at that same address. Wait until the log says Bifrost is serving. If port 8080 is already taken, a container is already running. Do not start a second one.

A governance-plugin warning at startup is safe to ignore. LLM Logs record completed calls.

## 5. Launch the extension

Open **this repo** in VS Code, not the sample shop.

1. Open **Run and Debug**.
2. Choose **Run TokenPilot**.
3. Press F5.

The launch task builds `dist/extension.js`, then opens an Extension Development Host with `../tokenpilot-test` as the folder. After you change extension code, stop that window and press F5 again.

## 6. Run the demo

In the Extension Development Host:

1. Open the secondary sidebar. The TokenPilot icon is next to the other sidebar views. If it is hidden, use **View: Appearance** and turn on the secondary side bar, or run **TokenPilot: Open Chat**.
2. In Chat, press **Demo prompt**.
3. Leave the route on **Custom harness** and press **Send**. Enter sends. Shift+Enter inserts a newline.
4. Press **New chat**. Switch the route to **Bare Bifrost (Cursor harness)** and send the same prompt.

New chat matters. The next send should not carry the previous reply.

Under a custom reply, the meta line looks like:

```
Custom harness · gemini-3.5-flash-lite · prompt 2203 → 644 · completion 56 · ollama ran, draft dropped, toon 530
```

`prompt` is the Cursor-harness size of that task, then the size actually sent. `completion` is what Gemini wrote. `toon 530` is how many tokens the JSON packing saved. When Ollama returns text, **Ollama wrote** sits under the line. It stays closed until the arrow is opened. Bifrost's own log shows the Gemini call, which is the prompt after the rewrite and the packing.

The sample shop is the context for that prompt. `Cart.submit` calls `checkout`, which calls `charge(card, amount, guest)` and writes the ledger. The card number is never logged.
