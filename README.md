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

## Run with Docker

Docker Compose runs the Nginx frontend, Fastify backend, and Cloudflare Tunnel as separate containers. SQLite data is kept in the `nutri_data` volume.

Make sure Ollama is running on the host and has the model available:

```bash
ollama serve
ollama pull gemma4:e2b
```

On Linux, allow the Ollama server to accept the Docker connection:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Copy the environment template and paste the token for your existing named Cloudflare Tunnel into `.env`:

```bash
cp .env.example .env
```

The existing tunnel's published application route must point to the Compose service:

```text
http://web:80
```

The Compose tunnel service mounts `/home/shaahir/.cloudflared` and runs the existing `Backendhost` configuration. If your home directory or tunnel name differs, change `CLOUDFLARED_DIR` or `CLOUDFLARED_TUNNEL_NAME` in `.env`.

Start Nutri:

```bash
docker compose up --build
```

Open your existing Cloudflare hostname. The local address `http://localhost:5173` remains available for testing. To use a different Ollama address or model, edit the root `.env` file:

```env
OLLAMA_URL=http://host.docker.internal:11434
OLLAMA_MODEL=gemma4:e2b
COOKIE_SECRET=use-a-long-random-value
WEB_PORT=5173
```

Stop the containers with `docker compose down`. The SQLite database remains in the named Docker volume unless it is explicitly removed.
