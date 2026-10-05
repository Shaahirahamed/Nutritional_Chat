# Nutri

Nutri is a ChatGPT-style nutrition assistant with a calm, food-inspired visual system. It includes a React/Vite client, Fastify API, SQLite persistence, profile personalization, SSE responses, and a safe wellness-oriented system prompt. Responses are generated locally through Ollama using `gemma4:e2b` by default.

## Run locally

Node.js 20+ and Ollama are recommended.

```bash
npm install
cp server/.env.example server/.env
ollama pull gemma4:e2b
npm run dev
```

Open `http://localhost:5173`. Ollama must be running locally at `http://127.0.0.1:11434` (the default Ollama address). Start it with `ollama serve` if it is not already running.

## Configuration

`server/.env.example` documents the runtime settings. Change `OLLAMA_URL` if Ollama is running elsewhere, or change `OLLAMA_MODEL` to use another locally installed model.

## Verification

```bash
npm run typecheck
npm run build
```
