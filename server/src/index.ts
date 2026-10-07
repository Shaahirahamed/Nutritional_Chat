import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import Database from 'better-sqlite3'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const app = Fastify({ logger: true })
const database = new Database(process.env.DATABASE_PATH ?? './nutri.db')
database.pragma('journal_mode = WAL')
database.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS profiles (session_id TEXT PRIMARY KEY, user_id TEXT, goal TEXT, diet TEXT, allergies TEXT, activity TEXT, age_range TEXT, metrics TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, conversation_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
`)

try { database.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT') } catch { /* existing database already migrated */ }
try { database.exec('ALTER TABLE profiles ADD COLUMN user_id TEXT') } catch { /* existing database already migrated */ }
try { database.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT') } catch { /* existing database already migrated */ }

const ollamaUrl = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
const ollamaModel = process.env.OLLAMA_MODEL ?? 'gemma4:e2b'
const messageSchema = z.object({ message: z.string().trim().min(1).max(4000), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(30).optional() })
const authSchema = z.object({ username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9_.-]+$/, 'Use letters, numbers, dots, hyphens, or underscores.'), password: z.string().min(8).max(128) })
const conversationSchema = z.object({ conversationId: z.string().uuid().nullable().optional(), message: z.string().trim().min(1).max(4000), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(30).optional() })

const systemPrompt = `You are Nutri, a warm and practical nutrition guide for generally healthy adults and fitness-focused users. Give helpful education, meal ideas, habit coaching, and approximate nutrition estimates. Use the user's profile when provided. Be clear that calorie and macro numbers are estimates. Do not diagnose conditions, prescribe treatment, change medications, or make claims of certainty. For pregnancy, eating disorders, severe symptoms, diabetes medication questions, severe allergies, or other medical-risk topics, acknowledge the limits of general guidance and recommend a qualified healthcare professional. For urgent symptoms, recommend immediate local emergency care. Keep answers concise, actionable, and encouraging. Avoid moralizing food.`

async function register() {
  await app.register(cors, { origin: true, credentials: true })
  await app.register(cookie, { secret: process.env.COOKIE_SECRET ?? 'local-development-secret' })

  app.addHook('preHandler', async (request, reply) => {
    let sessionId = request.cookies.nutri_session
    if (!sessionId) {
      sessionId = randomUUID()
      database.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(sessionId, new Date().toISOString())
      reply.setCookie('nutri_session', sessionId, { httpOnly: true, sameSite: 'lax', signed: false, path: '/', maxAge: 60 * 60 * 24 * 365 })
    }
    request.sessionId = sessionId
  })

  const currentUser = (sessionId: string) => database.prepare('SELECT id, username FROM users WHERE id = (SELECT user_id FROM sessions WHERE id = ?)').get(sessionId) as { id: string; username: string } | undefined
  const hashPassword = (password: string) => {
    const salt = randomBytes(16).toString('hex')
    return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
  }
  const verifyPassword = (password: string, stored: string) => {
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    const actual = scryptSync(password, salt, 64)
    const expected = Buffer.from(hash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const attachUserToSession = (sessionId: string, userId: string) => database.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(userId, sessionId)

  app.get('/api/health', async () => ({ ok: true, service: 'nutri' }))

  app.get('/api/me', async (request) => ({ user: currentUser(request.sessionId) ?? null }))

  app.post('/api/auth/register', async (request, reply) => {
    const input = authSchema.parse(request.body)
    const existing = database.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(input.username)
    if (existing) return reply.code(409).send({ error: 'That username is already taken.' })
    const userId = randomUUID()
    database.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(userId, input.username, hashPassword(input.password), new Date().toISOString())
    attachUserToSession(request.sessionId, userId)
    return reply.code(201).send({ user: { id: userId, username: input.username } })
  })

  app.post('/api/auth/login', async (request, reply) => {
    const input = authSchema.parse(request.body)
    const user = database.prepare('SELECT id, username, password_hash FROM users WHERE lower(username) = lower(?)').get(input.username) as { id: string; username: string; password_hash: string } | undefined
    if (!user || !verifyPassword(input.password, user.password_hash)) return reply.code(401).send({ error: 'Incorrect username or password.' })
    attachUserToSession(request.sessionId, user.id)
    return reply.send({ user: { id: user.id, username: user.username } })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    database.prepare('UPDATE sessions SET user_id = NULL WHERE id = ?').run(request.sessionId)
    return reply.clearCookie('nutri_session', { path: '/' }).send({ ok: true })
  })

  app.get('/api/profile', async (request) => {
    const user = currentUser(request.sessionId)
    const profile = user
      ? database.prepare('SELECT * FROM profiles WHERE session_id = ? OR user_id = ? ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END LIMIT 1').get(request.sessionId, user.id, user.id) as Record<string, unknown> | undefined
      : database.prepare('SELECT * FROM profiles WHERE session_id = ?').get(request.sessionId) as Record<string, unknown> | undefined
    return profile ? { ...profile, metrics: profile.metrics ? JSON.parse(String(profile.metrics)) : null } : null
  })

  app.put('/api/profile', async (request, reply) => {
    const profile = z.object({ goal: z.string().max(120).optional(), diet: z.string().max(120).optional(), allergies: z.string().max(500).optional(), activity: z.string().max(120).optional(), ageRange: z.string().max(80).optional(), metrics: z.record(z.string()).optional() }).parse(request.body)
    database.prepare(`INSERT INTO profiles (session_id, user_id, goal, diet, allergies, activity, age_range, metrics, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id, goal=excluded.goal, diet=excluded.diet, allergies=excluded.allergies, activity=excluded.activity, age_range=excluded.age_range, metrics=excluded.metrics, updated_at=excluded.updated_at`).run(request.sessionId, currentUser(request.sessionId)?.id ?? null, profile.goal ?? '', profile.diet ?? '', profile.allergies ?? '', profile.activity ?? '', profile.ageRange ?? '', JSON.stringify(profile.metrics ?? {}), new Date().toISOString())
    return reply.send({ ok: true })
  })

  app.get('/api/conversations', async (request) => {
    const user = currentUser(request.sessionId)
    const query = 'SELECT id, title, substr((SELECT content FROM messages WHERE conversation_id = conversations.id AND role = \'user\' ORDER BY created_at LIMIT 1), 1, 70) AS preview, updated_at AS updatedAt FROM conversations WHERE user_id = ? OR session_id = ? ORDER BY updated_at DESC'
    return user ? database.prepare(query).all(user.id, request.sessionId) : database.prepare(query).all(null, request.sessionId)
  })

  app.get('/api/conversations/:id', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params)
    const user = currentUser(request.sessionId)
    const conversation = database.prepare('SELECT id, title FROM conversations WHERE id = ? AND (user_id = ? OR session_id = ?)').get(params.id, user?.id ?? null, request.sessionId) as { id: string; title: string } | undefined
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found.' })
    const messages = database.prepare('SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(params.id)
    return { ...conversation, messages }
  })

  app.post('/api/chat', async (request, reply) => {
    const input = conversationSchema.parse(request.body)
    const profile = database.prepare('SELECT * FROM profiles WHERE session_id = ?').get(request.sessionId) as Record<string, unknown> | undefined
    const profileContext = profile ? `\nUser profile: goal=${profile.goal}; diet=${profile.diet}; allergies=${profile.allergies}; activity=${profile.activity}; age range=${profile.age_range}; metrics=${profile.metrics}` : ''
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const send = (payload: object) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    let fullResponse = ''
    try {
      let conversationId = input.conversationId
      if (conversationId) {
        const user = currentUser(request.sessionId)
        const exists = database.prepare('SELECT id FROM conversations WHERE id = ? AND (user_id = ? OR session_id = ?)').get(conversationId, user?.id ?? null, request.sessionId)
        if (!exists) conversationId = undefined
      }
      if (!conversationId) {
        conversationId = randomUUID()
        const now = new Date().toISOString()
        database.prepare('INSERT INTO conversations (id, session_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(conversationId, request.sessionId, currentUser(request.sessionId)?.id ?? null, input.message.slice(0, 52), now, now)
      }
      database.prepare('INSERT INTO messages (id, session_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), request.sessionId, conversationId, 'user', input.message, new Date().toISOString())
      send({ conversationId })
      const history = input.history ?? []
      const messages = history.length > 0 && history[history.length - 1]?.role === 'user' && history[history.length - 1]?.content === input.message
        ? history
        : [...history, { role: 'user' as const, content: input.message }]
      const ollamaResponse = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, stream: true, messages: [{ role: 'system', content: systemPrompt + profileContext }, ...messages] }),
      })
      if (ollamaResponse.ok && ollamaResponse.body) {
        const reader = ollamaResponse.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string }
            if (chunk.error) throw new Error(chunk.error)
            const delta = chunk.message?.content ?? ''
            if (delta) { fullResponse += delta; send({ delta }) }
          }
        }
      } else if (!ollamaResponse.ok) {
        const details = await ollamaResponse.text()
        throw new Error(`Ollama is unavailable (${ollamaResponse.status}). ${details || `Run ollama pull ${ollamaModel}.`}`)
      } else {
        throw new Error(`Ollama returned no response body. Run ollama pull ${ollamaModel}.`)
      }
      database.prepare('INSERT INTO messages (id, session_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), request.sessionId, conversationId, 'assistant', fullResponse, new Date().toISOString())
      database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conversationId)
      send({ done: true })
    } catch (error) {
      send({ error: error instanceof Error ? error.message : 'The nutrition service is temporarily unavailable.' })
    } finally { reply.raw.end() }
  })
}

declare module 'fastify' { interface FastifyRequest { sessionId: string } }
register().then(() => app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' })).catch((error) => { app.log.error(error); process.exit(1) })
