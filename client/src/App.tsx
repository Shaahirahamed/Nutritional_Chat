import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react'

type Message = { id: string; role: 'user' | 'assistant'; content: string }
type Conversation = { id: string; title: string; preview: string | null; updatedAt: string }
type Profile = { goal: string; diet: string; allergies: string; activity: string; ageRange: string }
type User = { id: string; username: string }

const starters = [
  { icon: '🥗', title: 'Build a balanced plate', text: 'What does a balanced lunch look like for my goals?' },
  { icon: '⚡', title: 'Fuel my workout', text: 'What should I eat before and after training?' },
  { icon: '🛒', title: 'Plan my groceries', text: 'Create a simple, high-protein grocery list for the week.' },
  { icon: '🍋', title: 'Learn the basics', text: 'Explain macros in a simple, practical way.' },
]

const initialMessage: Message = { id: 'welcome', role: 'assistant', content: 'Hi! I’m Nutri, your everyday nutrition guide. Tell me what you’re working toward and I’ll help you make a plan that feels realistic, enjoyable, and sustainable.' }

function App() {
  const [messages, setMessages] = useState<Message[]>([initialMessage])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile>({ goal: '', diet: '', allergies: '', activity: '', ageRange: '' })
  const [profileSaved, setProfileSaved] = useState(false)
  const [authError, setAuthError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => { document.documentElement.dataset.theme = darkMode ? 'dark' : 'light' }, [darkMode])
  useEffect(() => { void loadAppData() }, [])

  const loadAppData = async () => {
    try {
      const [meResponse, conversationsResponse, profileResponse] = await Promise.all([fetch('/api/me'), fetch('/api/conversations'), fetch('/api/profile')])
      const me = await meResponse.json() as { user: User | null }
      const savedConversations = await conversationsResponse.json() as Conversation[]
      const savedProfile = await profileResponse.json() as Record<string, unknown> | null
      setUser(me.user); setConversations(savedConversations)
      if (savedProfile) setProfile({ goal: String(savedProfile.goal ?? ''), diet: String(savedProfile.diet ?? ''), allergies: String(savedProfile.allergies ?? ''), activity: String(savedProfile.activity ?? ''), ageRange: String(savedProfile.age_range ?? '') })
    } catch { /* The chat remains usable while the backend reconnects. */ }
  }

  const startNewChat = () => { setConversationId(null); setMessages([initialMessage]); setInput(''); setSidebarOpen(false) }

  const openConversation = async (id: string) => {
    const response = await fetch(`/api/conversations/${id}`)
    if (!response.ok) return
    const conversation = await response.json() as { id: string; messages: Message[] }
    setConversationId(conversation.id); setMessages(conversation.messages.length ? conversation.messages : [initialMessage]); setSidebarOpen(false)
  }

  const sendMessage = async (event?: FormEvent | KeyboardEvent, prompt?: string) => {
    event?.preventDefault()
    const text = (prompt ?? input).trim()
    if (!text || isStreaming) return
    setInput('')
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text }
    const assistantId = crypto.randomUUID()
    const history = [...messages.filter((message) => message.id !== 'welcome'), userMessage]
    setMessages((current) => [...current.filter((message) => message.id !== 'welcome'), userMessage, { id: assistantId, role: 'assistant', content: '' }])
    setIsStreaming(true); abortRef.current = new AbortController()
    let activeConversationId = conversationId
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, message: text, history }), signal: abortRef.current.signal })
      if (!response.ok || !response.body) throw new Error('Unable to connect to Nutri.')
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true }); const events = buffer.split('\n\n'); buffer = events.pop() ?? ''
        for (const eventChunk of events) {
          const line = eventChunk.split('\n').find((item) => item.startsWith('data: ')); if (!line) continue
          const payload = JSON.parse(line.slice(6)) as { conversationId?: string; delta?: string; error?: string }
          if (payload.error) throw new Error(payload.error)
          if (payload.conversationId) { activeConversationId = payload.conversationId; setConversationId(payload.conversationId) }
          if (payload.delta) setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: item.content + payload.delta } : item))
        }
      }
      if (activeConversationId) await refreshConversations()
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: `I’m having trouble reaching the nutrition service right now. ${error instanceof Error ? error.message : 'Please try again.'}` } : item))
    } finally { setIsStreaming(false); abortRef.current = null }
  }

  const refreshConversations = async () => { const response = await fetch('/api/conversations'); if (response.ok) setConversations(await response.json() as Conversation[]) }
  const saveProfile = async (event: FormEvent) => { event.preventDefault(); await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) }); setProfileSaved(true); window.setTimeout(() => setProfileSaved(false), 2200) }
  const authenticate = async (event: FormEvent) => {
    event.preventDefault(); setAuthError(''); const form = new FormData(event.currentTarget as HTMLFormElement)
    const response = await fetch(`/api/auth/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) })
    const result = await response.json() as { user?: User; error?: string }
    if (!response.ok || !result.user) { setAuthError(result.error ?? 'Unable to authenticate.'); return }
    setUser(result.user); setAuthOpen(false); setAuthError(''); await loadAppData()
  }
  const logout = async () => { await fetch('/api/auth/logout', { method: 'POST' }); setUser(null); setConversations([]); setProfileOpen(false); startNewChat() }

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-top"><div className="brand"><span className="brand-mark">✦</span><span>nutri</span></div><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>×</button></div>
      <button className="new-chat" onClick={startNewChat}><span>＋</span> New chat</button>
      <div className="sidebar-label">Your chats</div>
      <div className="conversation-list">{conversations.length ? conversations.map((conversation) => <button className={`conversation ${conversationId === conversation.id ? 'selected' : ''}`} key={conversation.id} onClick={() => void openConversation(conversation.id)}><span className="conversation-icon">◒</span><span className="conversation-copy"><strong>{conversation.title}</strong><small>{conversation.preview || 'No messages yet'}</small></span><span className="conversation-time">{formatDate(conversation.updatedAt)}</span></button>) : <div className="empty-history">Your saved conversations will appear here.</div>}</div>
      <div className="sidebar-bottom"><button className="sidebar-action" onClick={() => user ? setProfileOpen(true) : setAuthOpen(true)}><span>◎</span><span>{user ? 'My profile' : 'Sign in to save'}</span><span className="action-chevron">›</span></button><button className="sidebar-action" onClick={() => setDarkMode((value) => !value)}><span>{darkMode ? '☼' : '◐'}</span><span>{darkMode ? 'Light mode' : 'Dark mode'}</span><span className="toggle-dot" /></button><div className="sidebar-disclaimer">Nutri gives general wellness guidance, not medical advice.</div></div>
    </aside>
    {sidebarOpen && <button className="scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><button className="menu-button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}>☰</button><div className="mobile-title"><span className="brand-mark">✦</span> nutri</div><div className="topbar-spacer" /><button className="profile-button" onClick={() => user ? setProfileOpen(true) : setAuthOpen(true)}><span className="avatar">{user ? user.username.slice(0, 1).toUpperCase() : '?'}</span><span className="profile-name">{user?.username ?? 'Sign in'}</span><span className="chevron">⌄</span></button></header>
      <section className="chat-scroll"><div className="chat-column">{messages.length === 1 && <div className="welcome-block"><div className="welcome-orb"><span>✦</span></div><p className="eyebrow">Your everyday nutrition guide</p><h1>Small choices.<br /><em>Better nourishment.</em></h1><p className="welcome-copy">Ask anything about food, fitness, and feeling your best. I’ll keep it practical and tailored to you.</p></div>}<div className="messages">{messages.map((message) => <MessageBubble key={message.id} message={message} />)}{messages.length === 1 && <div className="starter-grid">{starters.map((starter) => <button className="starter-card" key={starter.title} onClick={() => void sendMessage(undefined, starter.text)}><span className="starter-icon">{starter.icon}</span><span><strong>{starter.title}</strong><small>{starter.text}</small></span><span className="starter-arrow">↗</span></button>)}</div>}</div></div></section>
      <div className="composer-wrap"><form className="composer" onSubmit={sendMessage}><button type="button" className="composer-icon" aria-label="Add context">＋</button><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Message Nutri..." rows={1} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(event) } }} />{isStreaming ? <button type="button" className="send-button stop" aria-label="Stop response" onClick={() => abortRef.current?.abort()}>■</button> : <button type="submit" className="send-button" aria-label="Send message" disabled={!input.trim()}>↑</button>}</form><p className="composer-note">Nutri can make mistakes. Check important nutrition information with a qualified professional.</p></div>
    </main>
    {profileOpen && <ProfileModal profile={profile} setProfile={setProfile} saved={profileSaved} onSave={saveProfile} onClose={() => setProfileOpen(false)} onLogout={logout} username={user?.username ?? ''} />}
    {authOpen && <AuthModal mode={authMode} setMode={setAuthMode} error={authError} onSubmit={authenticate} onClose={() => { setAuthOpen(false); setAuthError('') }} />}
  </div>
}

function MessageBubble({ message }: { message: Message }) { return message.role === 'user' ? <div className="message-row user-row"><div className="user-bubble">{message.content}</div></div> : <div className="message-row assistant-row"><div className="assistant-avatar">✦</div><div className="assistant-content"><div className="assistant-name">Nutri</div><div className="assistant-text">{message.content || <span className="typing"><i /><i /><i /></span>}</div></div></div> }
function ProfileModal({ profile, setProfile, saved, onSave, onClose, onLogout, username }: { profile: Profile; setProfile: (value: Profile) => void; saved: boolean; onSave: (event: FormEvent) => void; onClose: () => void; onLogout: () => void; username: string }) { return <div className="modal-scrim" onClick={onClose}><section className="profile-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">{username}</p><h2>Your nutrition profile</h2></div><button className="modal-close" onClick={onClose}>×</button></div><p className="modal-copy">Share a little context so Nutri can make suggestions that fit your life.</p><form onSubmit={onSave}><label>Primary goal<select value={profile.goal} onChange={(event) => setProfile({ ...profile, goal: event.target.value })}><option value="">Choose a goal</option><option>Build healthier habits</option><option>Build muscle</option><option>Improve energy</option><option>Lose weight sustainably</option><option>Support my training</option></select></label><label>Dietary pattern<input value={profile.diet} onChange={(event) => setProfile({ ...profile, diet: event.target.value })} placeholder="e.g. vegetarian, no preference" /></label><label>Allergies or foods to avoid<input value={profile.allergies} onChange={(event) => setProfile({ ...profile, allergies: event.target.value })} placeholder="e.g. peanuts, shellfish" /></label><label>Activity level<select value={profile.activity} onChange={(event) => setProfile({ ...profile, activity: event.target.value })}><option value="">Choose activity level</option><option>Lightly active</option><option>Moderately active</option><option>Very active</option></select></label><label>Age range<input value={profile.ageRange} onChange={(event) => setProfile({ ...profile, ageRange: event.target.value })} placeholder="e.g. 25–34" /></label><div className="modal-actions"><button type="button" className="cancel-button" onClick={onLogout}>Sign out</button><button type="submit" className="save-button">{saved ? 'Saved ✓' : 'Save profile'}</button></div></form></section></div> }
function AuthModal({ mode, setMode, error, onSubmit, onClose }: { mode: 'login' | 'register'; setMode: (mode: 'login' | 'register') => void; error: string; onSubmit: (event: FormEvent) => void; onClose: () => void }) { return <div className="modal-scrim" onClick={onClose}><section className="profile-modal auth-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Nutri account</p><h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2></div><button className="modal-close" onClick={onClose}>×</button></div><p className="modal-copy">Use a username and password to keep your profile and chats together.</p><form onSubmit={onSubmit}><label>Username<input name="username" autoComplete="username" required minLength={3} maxLength={30} placeholder="e.g. alex" /></label><label>Password<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} placeholder="At least 8 characters" /></label>{error && <div className="auth-error">{error}</div>}<button type="submit" className="save-button auth-submit">{mode === 'login' ? 'Sign in' : 'Create account'}</button></form><button className="auth-switch" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Need an account? Create one' : 'Already have an account? Sign in'}</button></section></div> }
function formatDate(value: string) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }

export default App
