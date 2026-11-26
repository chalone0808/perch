#!/usr/bin/env bun
// The laptop watcher: one background process per machine.
// Hooks talk to it over a unix socket; it syncs with the relay server when one is configured.
import { Database } from 'bun:sqlite'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, chmodSync, existsSync, rmSync, statSync, fstatSync, openSync, readSync, closeSync } from 'node:fs'
import { hostname, homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Keys, E2E_VERSION, fingerprint, isPub, directRequestProof, directResponseProof, sameProof, type Version } from './e2e'
import { relayFetch } from './net'
import { VERSION, PROTOCOL } from './version'

export const HOME = process.env.PERCH_HOME ?? `${process.env.HOME}/.perch`
export const SOCK = `${HOME}/watcher.sock`

export type Msg = {
  id: string; type: string; session_id?: string | null; body: any; ts: string; notify?: boolean
  /// The machine a phone message is addressed to; direct endpoints drop messages for other machines.
  machine?: string
  /// Only these phone keys can open the body. Absent means every currently paired phone.
  to?: string[]
  /// Replayed live state for a newly paired phone; it must not raise a notification.
  snapshot?: boolean
}
type Decision = { behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown; updatedPermissions?: unknown[] }

// Turn the phone's choice into the hook's decision. The phone sends only choices (answers, a mode);
// the input Claude Code runs is rebuilt from the stored request, so a phone can't swap in another
// command or plan. Questions and plan approval need `allow` + updatedInput to count as answered.
export function toDecision(tool: string, input: any, choice: any): Decision {
  if (choice.behavior !== 'allow') {
    return typeof choice.message === 'string' && choice.message ? { behavior: 'deny', message: choice.message } : { behavior: 'deny' }
  }
  if (tool === 'AskUserQuestion') {
    const answers: Record<string, string> = {}
    for (const q of input?.questions ?? []) {
      const a = choice.answers?.[q.question]
      if (typeof a === 'string' && a.trim()) answers[q.question] = a.trim() // multi-select: labels joined with ", "
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }
  if (tool === 'ExitPlanMode') {
    // like the terminal's "Yes, and auto-accept edits"; the phone can't pick anything stronger
    const mode = choice.mode === 'acceptEdits' ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] : undefined
    return { behavior: 'allow', updatedInput: input, ...(mode ? { updatedPermissions: mode } : {}) }
  }
  return { behavior: 'allow' }
}

const COMMAND_RE = /^\/[\w:.-]+( [^\n\r]*)?$/ // one line, starts with /
// Phone text is pasted (bracketed paste, so newlines don't submit early). Strip control chars so it
// can't end the paste and press keys; keep newline and tab.
const paste = (text: string) => `\x1b[200~${text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\x1b[201~`

// Assistant text blocks appended to a transcript since `offset` (main thread only; subagents have
// their own files). Each block is its own JSONL line. Only whole lines are read, so a line still
// being written is picked up next time.
export function readTexts(path: string, offset: number): { texts: string[]; offset: number } {
  let fd: number
  try { fd = openSync(path, 'r') } catch { return { texts: [], offset } }
  try {
    const size = statSync(path).size
    if (size < offset) offset = 0 // rewritten
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    const end = buf.lastIndexOf(0x0a) + 1
    const texts: string[] = []
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue
      try {
        const d = JSON.parse(line)
        if (d.type !== 'assistant' || d.isSidechain) continue
        for (const b of d.message?.content ?? []) if (b?.type === 'text' && b.text?.trim()) texts.push(b.text)
      } catch {}
    }
    return { texts, offset: offset + end }
  } finally { closeSync(fd) }
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// A user prompt or queued message in a Claude Code transcript (after byte [from]) starting with
// [needle], compared with whitespace collapsed.
export function transcriptTook(path: string, from: number, needle: string): boolean {
  let tail = ''
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size <= from) return false
      const buf = Buffer.alloc(size - from)
      readSync(fd, buf, 0, buf.length, from)
      tail = buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return false }
  for (const line of tail.split('\n')) {
    let d: any
    try { d = JSON.parse(line) } catch { continue }
    const content =
      d.type === 'user' && typeof d.message?.content === 'string' ? d.message.content
      : d.type === 'queue-operation' && d.operation === 'enqueue' && typeof d.content === 'string' ? d.content
      : null
    if (content !== null && oneLine(content).startsWith(needle)) return true
  }
  return false
}
// Wait before retrying a failed sync: exponential (2s first, doubling), capped at a minute, with
// equal jitter so a relay outage doesn't have every laptop reconnect on the same tick.
export function retryDelay(failures: number, rand = Math.random): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(failures, 1) - 1, 5))
  return Math.round(base / 2 + (rand() * base) / 2)
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const shortPath = (p: string) => p.split('/').filter(Boolean).pop() ?? p

// Claude Code injects background-task results (and Stop-hook feedback) as user messages. The
// UserPromptSubmit hook sees them, but they are not something the user typed. Pull out just the
// summary so the phone can show a quiet note instead of a message "from the laptop".
export function taskNote(text: string): { status: string; summary: string } | null {
  const block = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(text)?.[1]
  if (!block) return null
  const field = (name: string) => oneLine(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? '')
  const status = field('status') || 'unknown' // Stop-hook feedback has no status
  const summary = clip(field('summary') || field('result') || 'Background task', 200)
  return { status, summary }
}

// What the agent is doing, for the phone. Only a few whitelisted fields are sent: file bodies and
// edit contents never leave the laptop. `summary` is one line; `detail` is for the detailed level.
export function toolSummary(tool: string, input: any): { tool: string; summary: string; detail?: string } {
  const str = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : '')
  let summary = ''
  let detail = ''
  switch (tool) {
    case 'Bash':
      summary = str('description') || oneLine(str('command'))
      detail = str('command')
      break
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = str('file_path') || str('notebook_path') // NotebookEdit uses notebook_path
      summary = shortPath(path)
      detail = path
      break
    }
    case 'Grep':
      summary = str('pattern')
      detail = [str('pattern'), str('path') || str('glob')].filter(Boolean).join('  ')
      break
    case 'Glob':
      summary = str('pattern')
      detail = str('path')
      break
    case 'WebFetch':
      try { summary = new URL(str('url')).host } catch { summary = str('url') }
      detail = str('url')
      break
    case 'WebSearch':
      summary = str('query')
      break
    case 'Task':
    case 'Agent':
      summary = str('description') || oneLine(str('prompt'))
      detail = str('prompt')
      break
    case 'TodoWrite':
      summary = `${Array.isArray(input?.todos) ? input.todos.length : 0} items`
      break
    case 'AskUserQuestion': {
      const first = input?.questions?.[0]?.question
      summary = typeof first === 'string' ? first : 'Question'
      break
    }
    case 'ExitPlanMode':
      summary = 'Plan ready'
      break
    default:
      summary = ['command', 'file_path', 'path', 'query', 'url', 'prompt', 'description']
        .map(str).find(Boolean) ?? ''
      detail = summary
  }
  detail = clip(detail, 1200)
  return { tool, summary: clip(oneLine(summary) || tool, 120), ...(detail ? { detail } : {}) }
}

export type CommandInfo = { name: string; description: string }

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/

// Just the frontmatter fields the phone needs; skill/command bodies stay on the laptop.
function readMeta(path: string): Record<string, string> {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return {} }
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  if (!block) return {}
  const out: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

// Legacy slash commands: .claude/commands/**/*.md, with nested folders becoming `folder:name`.
function commandFiles(dir: string, prefix: string, add: (c: CommandInfo) => void, depth = 0) {
  if (depth > 6) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (e.isDirectory()) {
      commandFiles(path, `${prefix}${e.name}:`, add, depth + 1)
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const name = `${prefix}${e.name.slice(0, -3)}`
      add({ name, description: clip(oneLine(readMeta(path).description ?? ''), 160) })
    }
  }
}

// Skills: .claude/skills/<dir>/SKILL.md. A skill wins over a command file with the same name.
function skillDirs(dir: string, add: (c: CommandInfo) => void) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const file = join(dir, e.name, 'SKILL.md')
    if (!existsSync(file)) continue
    const meta = readMeta(file)
    if ((meta['user-invocable'] ?? '').toLowerCase() === 'false') continue
    const declared = meta.name ?? ''
    const name = COMMAND_NAME.test(declared) ? declared : e.name
    if (!COMMAND_NAME.test(name)) continue
    add({ name, description: clip(oneLine(meta.description ?? ''), 160) })
  }
}

/// The slash commands the phone can offer for a session: user-level and project skills/commands.
/// Built-ins live in the app, so this only carries what is specific to this laptop and project.
export function discoverCommands(cwd: string, home = process.env.HOME ?? homedir()): CommandInfo[] {
  const found = new Map<string, CommandInfo>()
  const add = (c: CommandInfo) => { if (COMMAND_NAME.test(c.name)) found.set(c.name, c) }

  commandFiles(join(home, '.claude/commands'), '', add)
  skillDirs(join(home, '.claude/skills'), add)

  // Project config is discovered from the working directory up to the root. Add the outermost
  // first so the nearest directory (and a skill over a command) wins.
  const roots: string[] = []
  let dir = cwd
  while (roots.length < 16) {
    if (dir !== home) roots.push(dir) // user-level files were already added
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const root of roots.reverse()) {
    commandFiles(join(root, '.claude/commands'), '', add)
    skillDirs(join(root, '.claude/skills'), add)
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export class Watcher {
  db: Database
  // sessions where a permission dialog may be open in the terminal with no phone request behind it
  // (the hook timed out); typing there could answer the dialog, so hold messages until the turn ends
  blocked = new Set<string>()
  // Sessions with a turn in flight. A permission hook can outlive its turn (answering a question
  // in the terminal leaves the hook waiting until it expires), and an expiry after Stop must not
  // block typing for a turn that already ended.
  active = new Set<string>()
  perms = new Map<string, { session: string; tool: string; input: unknown; resolve: (d: Decision | null) => void }>()
  away: boolean
  home: string // where user-level skills and commands live (tests pass a temp directory)
  onOutbox = () => {}
  // Direct endpoint state. The listener is absent unless direct is enabled.
  directPort?: number
  directService?: DirectService
  directWaiters = new Set<() => void>()
  addresses = directAddrs // overridable in tests so hints are deterministic
  machine?: string
  key?: string // this machine's public key, once syncing
  keyDelay = 100 // ms between key chunks, so Enter isn't swallowed into a paste
  // the command list last sent per session, so routine hooks don't repeat it
  sentCommands = new Map<string, string>()
  // text typed into a terminal on the phone's behalf; the UserPromptSubmit echo of it is dropped.
  // Recorded before typing (Claude's echo can beat the keystrokes back to us) and matched for a
  // while, since a busy agent only submits queued input at its next tool call.
  // ponytail: in memory, so a watcher restart can mirror one typed prompt back
  typed: { text: string; at: number }[] = []
  // types into the session's terminal via the `perch claude` launcher that owns it
  keys = async (sock: string, data: string) => (await fetch('http://perch/keys', { unix: sock, method: 'POST', body: data })).ok
  // transcript read position per session, and recent texts already sent (the final reply comes
  // from the Stop hook before it's in the transcript; it must not be sent again when it lands)
  // ponytail: in memory; after a watcher restart, reading resumes from the end of the transcript
  read = new Map<string, { path: string; offset: number; sent: string[] }>()

  constructor(path: string, opts: { home?: string } = {}) {
    this.db = new Database(path)
    this.home = opts.home ?? process.env.HOME ?? homedir()
    this.db.exec(`
      create table if not exists outbox (seq integer primary key autoincrement, id text unique, json text);
      create table if not exists inbox (id text primary key, session_id text, type text, body text, state text);
      create table if not exists sessions (id text primary key, cwd text, keys text, updated text);
      create table if not exists kv (k text primary key, v text);`)
    this.away = this.get('away') === '1'
  }

  get(k: string) {
    return (this.db.query('select v from kv where k = ?').get(k) as { v: string } | null)?.v
  }
  set(k: string, v: string) {
    this.db.run('insert or replace into kv values (?, ?)', [k, v])
  }

  emit(type: string, session_id: string | null, body: any, notify = false, to?: string[], snapshot = false) {
    const m: Msg = {
      id: randomUUID(), type, session_id, body, ts: new Date().toISOString(),
      ...(notify ? { notify: true } : {}),
      ...(to?.length ? { to } : {}),
      ...(snapshot ? { snapshot: true } : {}),
    }
    this.db.run('insert into outbox (id, json) values (?, ?)', [m.id, JSON.stringify(m)])
    this.onOutbox()
    for (const wake of [...this.directWaiters]) wake()
  }

  // Publish the session's own slash commands. A new session always gets one; later hooks only send
  // it when the set changed (say, the agent created a skill during the turn).
  refreshCommands(session_id: string, cwd: string | null | undefined, force = false, to?: string[], snapshot = false) {
    if (!cwd) return
    let commands: CommandInfo[]
    try { commands = discoverCommands(cwd, this.home) } catch { return }
    const key = JSON.stringify(commands)
    if (!force && this.sentCommands.get(session_id) === key) return
    this.sentCommands.set(session_id, key)
    this.emit('commands', session_id, { commands }, false, to, snapshot)
  }

  /// A phone that pairs after messages were sent cannot open them: each body is sealed for the
  /// phones that existed at send time. Give the new phone the live state it missed, sealed only to
  /// it so existing phones do not get duplicate session cards or approval dialogs. History is not
  /// replayed; it arrives through iCloud sync or an export.
  snapshotTo(phone: string) {
    const to = [phone]
    const live = this.db.query(`select id, cwd from sessions where keys is not null order by updated desc`)
      .all() as { id: string; cwd: string }[]
    for (const s of live) {
      this.emit('session_start', s.id, { cwd: s.cwd, machine: hostname() }, false, to, true)
      this.refreshCommands(s.id, s.cwd, true, to, true)
    }
    for (const [request_id, p] of this.perms) {
      this.emit('needs_attention', p.session, { request_id, tool_name: p.tool, tool_input: p.input }, false, to, true)
    }
    this.emit('presence', null, { away: this.away }, false, to, true)
  }

  // Forward the agent's text written since the last look: replies between tool calls never reach
  // the Stop hook, which only carries the last one. Sent as partial replies (the turn goes on).
  texts(session_id: string, path?: string | null, final?: string) {
    if (!path) return
    let r = this.read.get(session_id)
    if (!r || r.path !== path) {
      let size = 0
      try { size = statSync(path).size } catch {}
      this.read.set(session_id, (r = { path, offset: size, sent: [] })) // new or resumed: skip history
    }
    const { texts, offset } = readTexts(path, r.offset)
    r.offset = offset
    let seen = false
    for (const text of texts) {
      const i = r.sent.indexOf(text)
      if (i >= 0) { r.sent.splice(i, 1); continue }
      if (text === final && !seen) { seen = true; continue }
      this.emit('agent_reply', session_id, { text, partial: true }, this.away)
    }
    if (final && !seen) { r.sent.push(final); if (r.sent.length > 10) r.sent.shift() }
  }

  // ---- called by hooks ----

  sessionStart({ session_id, cwd, keys, transcript, source }: {
    session_id: string; cwd: string; keys: string | null; transcript?: string | null; source?: string
  }) {
    this.claim(session_id, keys)
    if (source === 'compact') {
      // `/compact` rewrites (or replaces) the transcript with a summary of the old history. Pin the
      // read position to the end now: the summary isn't a new reply, and pinning here (rather than
      // lazily at the next hook) keeps the first text the agent writes afterwards.
      if (transcript) {
        let size = 0
        try { size = statSync(transcript).size } catch {}
        this.read.set(session_id, { path: transcript, offset: size, sent: [] })
      } else {
        this.read.delete(session_id)
      }
      this.emit('compact', session_id, {}, this.away)
    } else {
      this.texts(session_id, transcript)
    }
    this.db.run('insert or replace into sessions values (?, ?, ?, ?)', [session_id, cwd, keys, new Date().toISOString()])
    this.emit('session_start', session_id, { cwd, machine: hostname() })
    this.refreshCommands(session_id, cwd, true)
  }

  // One `perch claude` terminal runs one conversation at a time. `/resume` (or `/clear`) switches
  // to another session id in the same terminal: the old conversation is gone, so stop delivering
  // to it and tell the phone. Keys is the launcher's private socket, unique per terminal.
  claim(session_id: string, keys: string | null) {
    if (!keys) return
    const prev = this.db.query('select id from sessions where keys = ? and id != ?').all(keys, session_id) as { id: string }[]
    for (const p of prev) this.end(p.id, 'replaced')
  }

  // At startup, clean up conversations that can no longer be current: their launcher is gone,
  // or another conversation started later in the same terminal (`/resume` before this version).
  // Both would otherwise linger as stale (often empty) sessions on the phone.
  reconcile() {
    const alive = (sock: string) => {
      if (!existsSync(sock)) return false
      const m = /(\d+)\.sock$/.exec(sock) // `perch claude` names its key socket after its pid
      if (!m) return true
      try { process.kill(Number(m[1]), 0); return true } catch { return false }
    }
    const rows = this.db.query(`select id, keys from sessions where keys is not null order by updated`).all() as { id: string; keys: string }[]
    const current = new Map<string, string>()
    for (const r of rows) if (alive(r.keys)) current.set(r.keys, r.id) // last start in a terminal wins
    for (const r of rows) {
      if (!alive(r.keys)) this.end(r.id, 'launcher_gone')
      else if (current.get(r.keys) !== r.id) this.end(r.id, 'replaced')
    }
  }

  // SessionEnd hook. Only the terminal that owns the session may end it: a hook from another
  // launcher (or with no launcher) could otherwise stop deliveries to a live session.
  endFromHook({ session_id, reason, keys }: { session_id: string; reason?: string; keys: string | null }) {
    const row = this.db.query('select keys from sessions where id = ?').get(session_id) as { keys: string | null } | null
    if (row && row.keys !== keys) return false
    this.end(session_id, reason ?? 'other')
    return true
  }

  // The conversation ended or was replaced. Deliveries for it fail visibly.
  end(session_id: string, reason: string) {
    const row = this.db.query('select keys from sessions where id = ?').get(session_id) as { keys: string | null } | null
    if (row && row.keys === null) return // already ended
    this.active.delete(session_id)
    this.blocked.delete(session_id)
    this.db.run('update sessions set keys = null where id = ?', [session_id])
    const queued = this.db.query(`select id from inbox where session_id = ? and state = 'queued'`).all(session_id) as { id: string }[]
    if (queued.length) {
      this.db.run(`update inbox set state = 'failed' where session_id = ? and state = 'queued'`, [session_id])
      this.emit('delivery_failed', session_id, { ids: queued.map((r) => r.id), error: 'session ended' }, this.away)
    }
    this.emit('session_end', session_id, { reason })
  }

  // A prompt submitted in the terminal (UserPromptSubmit hook).
  userPrompt({ session_id, cwd, text, keys, transcript }: { session_id: string; cwd: string; text: string; keys?: string | null; transcript?: string | null }) {
    this.claim(session_id, keys ?? null)
    this.active.add(session_id) // a submitted prompt starts a turn
    this.texts(session_id, transcript) // leftovers from an interrupted turn (no Stop hook after Esc)
    this.refreshCommands(session_id, cwd)
    const i = this.typed.findIndex((t) => t.text === text && Date.now() - t.at < 30 * 60_000)
    if (i >= 0) return void this.typed.splice(i, 1) // this one came from the phone
    // A prompt submitted at the terminal means any dialog handed back to it was resolved; queued
    // phone messages can be typed (Claude Code queues mid-turn input natively) without waiting
    // for the turn to end.
    if (this.blocked.delete(session_id)) void this.flush(session_id)
    const note = taskNote(text)
    if (note) return void this.emit('task_note', session_id, { cwd, ...note }, this.away)
    this.emit('user_prompt', session_id, { cwd, text })
  }

  // PreToolUse: progress between replies. Read-only; the hook makes no decision.
  activity({ session_id, cwd, tool_name, tool_input, keys, transcript }: {
    session_id: string; cwd: string; tool_name: string; tool_input: unknown; keys?: string | null; transcript?: string | null
  }) {
    this.claim(session_id, keys ?? null)
    this.active.add(session_id) // tools run only inside a turn
    this.texts(session_id, transcript) // what the agent said before this tool call
    this.db.run('update sessions set cwd = ?, updated = ? where id = ?', [cwd, new Date().toISOString(), session_id])
    this.emit('activity', session_id, { cwd, ...toolSummary(tool_name, tool_input) })
  }

  stop({ session_id, cwd, text, keys, transcript }: { session_id: string; cwd: string; text: string; keys?: string | null; transcript?: string | null }) {
    this.claim(session_id, keys ?? null)
    this.texts(session_id, transcript, text)
    this.db.run('update sessions set cwd = ?, updated = ? where id = ?', [cwd, new Date().toISOString(), session_id])
    this.emit('agent_reply', session_id, { cwd, text }, this.away)
    this.refreshCommands(session_id, cwd)
    this.active.delete(session_id)
    this.blocked.delete(session_id) // turn over: no dialog can be open
    return this.flush(session_id)
  }

  permission(req: { session_id: string; tool_name: string; tool_input: unknown; keys?: string | null }, signal?: AbortSignal): Promise<Decision | null> {
    this.claim(req.session_id, req.keys ?? null)
    this.active.add(req.session_id) // a request exists only inside a turn
    if (!this.away) return Promise.resolve(null) // home: normal terminal prompt
    const request_id = randomUUID()
    this.emit('needs_attention', req.session_id, { request_id, tool_name: req.tool_name, tool_input: req.tool_input })
    return new Promise((resolve) => {
      this.perms.set(request_id, { session: req.session_id, tool: req.tool_name, input: req.tool_input, resolve })
      signal?.addEventListener('abort', () => {
        // hook timed out: the terminal dialog takes over, so stop typing into this session,
        // and close the card on the phone instead of leaving it pending forever
        if (this.perms.delete(request_id)) {
          if (this.active.has(req.session_id)) this.blocked.add(req.session_id)
          this.emit('request_expired', req.session_id, { request_id })
        }
      })
    })
  }

  // Hand pending approvals back to the terminal: the hook returns no decision, so Claude Code
  // shows its normal prompt. Typing stays blocked (like a timed-out hook) until the turn ends.
  releasePermissions() {
    for (const [request_id, p] of [...this.perms]) {
      this.perms.delete(request_id)
      if (this.active.has(p.session)) this.blocked.add(p.session)
      p.resolve(null)
      this.emit('request_expired', p.session, { request_id })
    }
  }

  // ---- called for every message from the phone (via server sync, or `perch send`) ----

  receive(m: Msg) {
    const fresh = this.db.run('insert or ignore into inbox values (?, ?, ?, ?, ?)', [
      m.id, m.session_id ?? null, m.type, JSON.stringify(m.body), 'done',
    ]).changes
    if (!fresh) return // at-least-once delivery: drop repeats
    const s = m.session_id!
    switch (m.type) {
      case 'prompt': {
        const perm = [...this.perms].find(([, p]) => p.session === s)
        if (perm) {
          // a message while an approval is pending means "no, do this instead"
          this.perms.delete(perm[0])
          perm[1].resolve({ behavior: 'deny', message: m.body.text })
          this.db.run(`update inbox set state = 'delivered' where id = ?`, [m.id])
          this.emit('delivered', s, { ids: [m.id] })
          return
        }
        this.db.run(`update inbox set state = 'queued' where id = ?`, [m.id])
        return void this.flush(s)
      }
      case 'decision': {
        const p = this.perms.get(m.body.request_id)
        // Already answered at the terminal or timed out: tell the phone its answer was too late,
        // so the card doesn't keep showing a decision the laptop never applied.
        if (!p) return this.emit('decision_result', s, { ref: m.id, ok: false, error: 'request expired' })
        this.perms.delete(m.body.request_id)
        return p.resolve(toDecision(p.tool, p.input, m.body))
      }
      case 'interrupt':
        return void this.type(s, ['\x1b']).then((ok) => this.emit('interrupted', s, { ref: m.id, ok })) // Esc
      case 'command': {
        const text = String(m.body.text)
        if (!COMMAND_RE.test(text)) return this.emit('command_result', s, { ref: m.id, ok: false, error: 'invalid command' })
        if (!this.canType(s)) return this.emit('command_result', s, { ref: m.id, ok: false, error: 'an approval is open on the laptop' })
        const echo = { text, at: Date.now() }
        this.typed.push(echo)
        return void this.type(s, [text, '\r']).then((ok) => {
          if (!ok) this.typed.splice(this.typed.indexOf(echo), 1)
          this.emit('command_result', s, { ref: m.id, ok })
        })
      }
      case 'presence':
        this.away = !!m.body.away
        this.set('away', this.away ? '1' : '0')
        this.emit('presence', null, { away: this.away }) // phone mirrors the laptop's actual state
        // Back at the keyboard: let the terminal own any request the phone hasn't answered, instead
        // of leaving the CLI blocked on a hook until the (long) phone timeout.
        if (!this.away) this.releasePermissions()
        for (const r of this.db.query(`select distinct session_id s from inbox where state = 'queued'`).all() as { s: string }[]) {
          void this.flush(r.s)
        }
        return
    }
  }

  async type(session: string, chunks: string[]) {
    const sock = (this.db.query('select keys from sessions where id = ?').get(session) as { keys: string | null } | null)?.keys
    if (!sock) return false
    try {
      for (const c of chunks) {
        if (!(await this.keys(sock, c))) return false
        await Bun.sleep(this.keyDelay)
      }
      return true
    } catch {
      return false // launcher gone: session ended
    }
  }

  // Typing is only safe when nobody is at the keyboard (away) and no permission dialog can be open.
  canType(session: string) {
    return this.away && !this.blocked.has(session) && ![...this.perms.values()].some((p) => p.session === session)
  }

  // Deliver queued phone messages by typing them into the session, like the user would.
  // Claude Code queues typed input natively: mid-turn it lands after the current tool call.
  async flush(session: string) {
    if (!this.canType(session)) return // Home mode or an open dialog: keep waiting
    const rows = this.db.query(`select id, body from inbox where session_id = ? and state = 'queued' order by rowid`).all(session) as { id: string; body: string }[]
    if (!rows.length) return
    const ids = rows.map((r) => r.id)
    const mark = (state: string) => this.db.run(`update inbox set state = ? where id in (${ids.map(() => '?').join()})`, [state, ...ids])
    mark('typing') // claim synchronously so a concurrent flush can't type them twice
    const text = rows.map((r) => JSON.parse(r.body).text).join('\n\n')
    const echo = { text, at: Date.now() } // before typing: the prompt hook can fire before type() returns
    this.typed.push(echo)
    if (this.typed.length > 20) this.typed.shift()
    const fail = (error: string) => {
      this.typed.splice(this.typed.indexOf(echo), 1)
      mark('failed')
      this.emit('delivery_failed', session, { ids, error }, this.away)
    }
    // Keystrokes reaching the terminal don't mean Claude Code took them (its input may not have had
    // focus, or the Enter was swallowed). It records every message it takes in the transcript, so
    // wait for that; press Enter once more in case the text sits unsubmitted, then give up loudly.
    const path = this.read.get(session)?.path
    let from = 0
    try { if (path) from = statSync(path).size } catch {}
    if (!(await this.type(session, [paste(text), '\r']))) return fail('session ended')
    if (path && !(await this.accepted(path, from, text))) {
      await this.type(session, ['\r'])
      if (!(await this.accepted(path, from, text))) return fail('not taken')
    }
    mark('delivered')
    this.emit('delivered', session, { ids })
  }

  acceptWait = 3000 // ms to wait for Claude Code to record a typed message

  /// Whether the transcript, past [from], shows Claude Code took [text]: as a prompt (idle) or a
  /// queue entry (mid-turn, sent at the next step).
  async accepted(path: string, from: number, text: string) {
    const needle = oneLine(text).slice(0, 80)
    const end = Date.now() + this.acceptWait
    for (;;) {
      if (transcriptTook(path, from, needle)) return true
      if (Date.now() >= end) return false
      await Bun.sleep(150)
    }
  }

  status() {
    return {
      version: VERSION,
      protocol: PROTOCOL,
      ...(this.machine ? { machine: this.machine } : {}),
      away: this.away,
      outbox: (this.db.query('select count(*) n from outbox').get() as { n: number }).n,
      sessions: this.db.query(`
        select s.id, s.cwd, s.updated,
          (select count(*) from inbox i where i.session_id = s.id and i.state = 'queued') queued
        from sessions s order by s.updated desc`).all(),
      blocked: [...this.blocked],
      pending_approvals: this.perms.size,
      ...(this.key ? { key: fingerprint(this.key) } : {}),
      direct: this.directService?.status() ?? { enabled: false, port: null, addrs: [] },
      phones: (this.phones() ?? []).map((p) => ({ name: p.name, key: fingerprint(p.pubkey) })),
    }
  }

  // Server contract (one endpoint, long-poll):
  //   POST {server}/v1/sync  Authorization: Bearer <token>
  //   body: { machine, after: <inbox cursor>, outbox: Msg[], wait: <seconds to hold if nothing new> }
  //   resp: { acked: string[] (outbox ids stored), inbox: Msg[] (phone→laptop, after cursor), cursor: number }
  // Every call doubles as the heartbeat. Server dedupes outbox by id; we dedupe inbox by id.
  // Bodies are end-to-end encrypted (see e2e.ts): sealed for every paired phone on the way out, and
  // only bodies sealed by a paired phone are accepted on the way in. The relay lists the phones'
  // public keys; until the first answer arrives nothing is sent (there'd be no one to seal for).
  /// What a phone's notification may show for [m], if the relay will push it: the session folder and
  /// one line of text. Sealed for the phones like the body; the relay forwards it unread.
  /// Approvals also carry the request id and kind, so the phone can offer Approve / Deny buttons on
  /// the notification itself.
  pushPreview(m: Msg): { cwd: string | null; text: string; request_id?: string; kind?: 'permission' | 'question' | 'plan' } | null {
    if (m.snapshot || (m.type !== 'needs_attention' && !m.notify)) return null
    const b = m.body ?? {}
    let text = ''
    let approval: { request_id: string; kind: 'permission' | 'question' | 'plan' } | null = null
    if (m.type === 'agent_reply') text = String(b.text ?? '')
    else if (m.type === 'task_note') text = String(b.summary ?? '')
    else if (m.type === 'needs_attention') {
      const questions = Array.isArray(b.tool_input?.questions) ? b.tool_input.questions : []
      const plan = typeof b.tool_input?.plan === 'string' ? b.tool_input.plan : ''
      const kind = questions[0]?.question ? 'question' : plan ? 'plan' : 'permission'
      if (kind === 'question') text = String(questions[0].question)
      else if (kind === 'plan') text = `Plan: ${plan.split('\n').map((l: string) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''}`
      else {
        const t = toolSummary(String(b.tool_name ?? ''), b.tool_input)
        text = t.summary ? `${t.tool}: ${t.summary}` : t.tool
      }
      if (typeof b.request_id === 'string') approval = { request_id: b.request_id, kind }
    } // Other kinds carry no text, only the session (inside the seal) for grouping and tapping.
    const row = this.db.query('select cwd from sessions where id = ?').get(m.session_id ?? '') as { cwd: string | null } | null
    return { cwd: typeof b.cwd === 'string' ? b.cwd : (row?.cwd ?? null), text: clip(oneLine(text), 200), ...approval }
  }

  /** The format every one of [recipients] reads: 2 only if all of them report it. */
  formatFor(recipients: string[]): Version {
    const phones = this.phones() ?? []
    return recipients.length && recipients.every((k) => phones.find((p) => p.pubkey === k)?.e2e === 2) ? 2 : 1
  }

  phones(): { name: string; pubkey: string; e2e?: number }[] | null {
    const v = this.get('phones')
    return v ? JSON.parse(v) : null
  }

  async sync(cfg: { server: string; token: string; machine?: string }, keys: Keys) {
    let ctrl = new AbortController()
    let polling = false
    let failures = 0
    this.onOutbox = () => polling && ctrl.abort() // new outbound message: cut the long-poll short
    for (;;) {
      ctrl = new AbortController()
      const phones = this.phones()
      const outbox = phones === null ? [] : (this.db.query('select json from outbox order by seq limit 100').all() as { json: string }[])
        .map((r) => JSON.parse(r.json))
        .map((m: Msg) => {
          const to = m.to?.length ? m.to : phones.map((p) => p.pubkey)
          const preview = this.pushPreview(m)
          const v = this.formatFor(to)
          return {
            ...keys.sealMessage('up', m, to, v),
            ...(preview ? { preview: keys.seal('push', { ...m, body: preview }, to, v) } : {}),
          }
        })
      polling = outbox.length === 0 && phones !== null
      const addrs = this.directPort && phones?.length ? this.addresses() : []
      const direct = this.directPort && addrs.length ? { port: this.directPort, addrs } : null
      try {
        const res = await relayFetch(`${cfg.server}/v1/sync`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ machine: cfg.machine ?? hostname(), pubkey: keys.pub, e2e: E2E_VERSION, version: VERSION, protocol: PROTOCOL, after: Number(this.get('cursor') ?? 0), outbox, wait: polling ? 25 : 0, direct }),
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(40_000)]),
        })
        if (!res.ok) throw new Error(`sync HTTP ${res.status}`)
        const { acked, inbox, cursor, phones: listed } = (await res.json()) as {
          acked: string[]; inbox: Msg[]; cursor: number; phones?: { name: string; pubkey: string | null; e2e?: number }[]
        }
        for (const id of acked) this.db.run('delete from outbox where id = ?', [id])
        const now = (listed ?? []).filter((p): p is { name: string; pubkey: string; e2e?: number } => !!p.pubkey)
        const added = phones === null ? [] : now.filter((p) => !phones.some((q) => q.pubkey === p.pubkey))
        for (const p of added) {
          console.error(new Date().toISOString(), `phone "${p.name}" key ${fingerprint(p.pubkey)}; sending live snapshot`)
        }
        this.set('phones', JSON.stringify(now))
        for (const p of added) this.snapshotTo(p.pubkey)
        for (const m of inbox) {
          const opened = keys.openMessage('down', m, now.map((p) => p.pubkey))
          if (opened) this.receive(opened)
          else console.error(new Date().toISOString(), `dropped ${m.type} ${m.id}: not encrypted by a paired phone (update the app?)`)
        }
        this.set('cursor', String(cursor))
        failures = 0
      } catch (e) {
        if (ctrl.signal.aborted) continue
        failures++
        console.error(new Date().toISOString(), 'sync failed:', (e as Error).message)
        await Bun.sleep(retryDelay(failures))
      }
    }
  }
}

export type DirectAddr = { host: string; network: 'lan' | 'tailscale' }
export type DirectInfo = { port: number; addrs: DirectAddr[] }

const DIRECT_TYPES = new Set(['prompt', 'command', 'decision', 'interrupt', 'presence'])

/// Private IPv4 addresses a phone can reach directly. Loopback, link-local and public addresses
/// are never advertised.
export function directAddrs(interfaces = networkInterfaces()): DirectAddr[] {
  const found = new Map<string, DirectAddr>()
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4') continue
      const host = i.address
      if (host.startsWith('10.') || host.startsWith('192.168.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host)) found.set(host, { host, network: 'lan' })
      else if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) found.set(host, { host, network: 'tailscale' })
    }
  }
  return [...found.values()]
    .sort((a, b) => (a.network === b.network ? a.host.localeCompare(b.host) : a.network === 'lan' ? -1 : 1))
    .slice(0, 8)
}

const isPrivatePeer = (peer: string) => {
  const p = peer.startsWith('::ffff:') ? peer.slice(7) : peer
  return p.startsWith('127.') || p === '::1' || p.startsWith('10.') || p.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(p) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(p)
}

export function directHandler(
  w: Watcher,
  opts: { machine: string; keys: Keys; now?: () => number },
) {
  const seen = new Map<string, number>() // "phone\nnonce" → expiry (seconds)
  const active = new Map<string, number>() // concurrent waiters per phone
  return async (req: Request, peer: string | null): Promise<Response> => {
    const path = new URL(req.url).pathname
    if (req.method !== 'POST' || path !== '/v1/direct/sync') return Response.json({ error: 'not found' }, { status: 404 })
    if (!peer || !isPrivatePeer(peer)) return Response.json({ error: 'forbidden' }, { status: 403 })

    const phone = req.headers.get('x-perch-phone') ?? ''
    const ts = req.headers.get('x-perch-ts') ?? ''
    const nonce = req.headers.get('x-perch-nonce') ?? ''
    const auth = req.headers.get('x-perch-auth') ?? ''
    const now = Math.floor((opts.now ?? Date.now)() / 1000)
    const stamp = Number(ts)
    if (!isPub(phone) || !/^\d+$/.test(ts) || !nonce || nonce.length > 64 || Math.abs(now - stamp) > 60)
      return Response.json({ error: 'unauthorized' }, { status: 401 })

    const phones = w.phones()
    if (!phones?.some((p) => p.pubkey === phone)) return Response.json({ error: 'unauthorized' }, { status: 401 })

    const raw = await req.text()
    if (raw.length > 1_048_576) return Response.json({ error: 'too large' }, { status: 413 })
    const key = opts.keys.directKey(phone)
    if (!sameProof(auth, directRequestProof(key, 'POST', path, ts, nonce, raw)))
      return Response.json({ error: 'unauthorized' }, { status: 401 })

    const id = `${phone}\n${nonce}`
    if ((seen.get(id) ?? 0) > now) return Response.json({ error: 'unauthorized' }, { status: 401 })
    seen.set(id, now + 120)
    if (seen.size > 2048) for (const [k, exp] of seen) if (exp <= now) seen.delete(k)

    let body: any
    try { body = JSON.parse(raw) } catch { return Response.json({ error: 'bad json' }, { status: 400 }) }

    const phoneKeys = phones.map((p) => p.pubkey)
    const acked: string[] = []
    for (const m of Array.isArray(body.outbox) ? body.outbox.slice(0, 100) : []) {
      if (!m || typeof m.id !== 'string' || m.id.length > 64 || !DIRECT_TYPES.has(m.type)) continue
      if (m.machine !== opts.machine) continue
      if (m.session_id != null && typeof m.session_id !== 'string') continue
      const opened = opts.keys.openMessage('down', m, phoneKeys)
      if (!opened) continue
      try { w.receive(opened) } catch { continue }
      acked.push(m.id)
    }

    const after = Number(body.after) || 0
    const wait = Math.min(Number(body.wait) || 0, 25)
    // The relay adds `machine` to every up-message it stores; direct rows carry no such field, so
    // add it here too. The phone groups sessions and routes prompts by it.
    const read = (from = after) => {
      let cursor = from
      const inbox: any[] = []
      const rows = w.db.query('select seq, json from outbox where seq > ? order by seq limit 100').all(from) as { seq: number; json: string }[]
      for (const row of rows) {
        cursor = row.seq
        const m = JSON.parse(row.json)
        if (Array.isArray(m.to) && m.to.length && !m.to.includes(phone)) continue
        inbox.push({ ...opts.keys.sealMessage('up', m, [phone], w.formatFor([phone])), machine: opts.machine })
      }
      return { inbox, cursor }
    }

    let result = read()
    if (!result.inbox.length && wait > 0) {
      if ((active.get(phone) ?? 0) >= 4) return Response.json({ error: 'too many waiters' }, { status: 429 })
      active.set(phone, (active.get(phone) ?? 0) + 1)
      try {
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); w.directWaiters.delete(done); resolve() }
          const timer = setTimeout(done, wait * 1000)
          w.directWaiters.add(done)
          req.signal.addEventListener('abort', done)
        })
        // Rows addressed to another phone were already skipped by the first read; resume after
        // them instead of scanning that range again.
        result = read(result.cursor)
      } finally {
        const left = (active.get(phone) ?? 1) - 1
        if (left > 0) active.set(phone, left)
        else active.delete(phone)
      }
    }

    const payload = JSON.stringify({ acked, inbox: result.inbox, cursor: result.cursor })
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-perch-auth': directResponseProof(key, nonce, payload) },
    })
  }
}

export function serveDirect(w: Watcher, opts: { machine: string; keys: Keys; port?: number }) {
  const handler = directHandler(w, opts)
  const start = (port: number) => Bun.serve({
    hostname: '0.0.0.0',
    port,
    idleTimeout: 40,
    maxRequestBodySize: 1_048_576,
    fetch(req, server) {
      return handler(req, server.requestIP(req)?.address ?? null)
    },
  })
  const preferred = opts.port ?? Number(process.env.PERCH_DIRECT_PORT ?? 8789)
  try { return start(preferred) } catch (e) {
    if ((e as { code?: string }).code !== 'EADDRINUSE') throw e
    return start(0)
  }
}

export class DirectService {
  private server?: ReturnType<typeof Bun.serve>
  constructor(private w: Watcher, private machine: string, private keys: Keys, private port?: number) {}

  get listening() { return !!this.server }
  start() {
    if (this.server) return
    this.server = serveDirect(this.w, { machine: this.machine, keys: this.keys, port: this.port })
    this.w.directPort = this.server.port
    this.w.onOutbox()
  }
  stop() {
    this.server?.stop(true)
    this.server = undefined
    this.w.directPort = undefined
    this.w.onOutbox()
  }
  status() {
    return { enabled: this.listening, port: this.server?.port ?? null, addrs: this.listening ? this.w.addresses() : [] }
  }
}

export function serve(w: Watcher, unix = SOCK) {
  const json = (x: unknown) => Response.json(x)
  return Bun.serve({
    unix,
    idleTimeout: 0, // waiters long-poll for hours
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === '/version')
        return json({ name: 'perch', version: VERSION, protocol: PROTOCOL, machine: w.machine ?? hostname(), pid: process.pid })
      if (req.method === 'GET' && path === '/status') return json(w.status())
      const b = req.method === 'POST' ? await req.json() : {}
      switch (path) {
        case '/hook/start': return json(w.sessionStart(b) ?? {})
        case '/hook/stop': return json((await w.stop(b)) ?? {})
        case '/hook/prompt': return json(w.userPrompt(b) ?? {})
        case '/hook/tool': return json(w.activity(b) ?? {})
        case '/hook/end': return json({ ok: w.endFromHook(b) })
        case '/hook/permission': return json({ decision: await w.permission(b, req.signal) })
        case '/inject': return json(w.receive({ id: randomUUID(), ts: new Date().toISOString(), ...b }) ?? {})
        case '/direct': {
          if (req.method !== 'POST') return json({ error: 'POST only' }, { status: 405 })
          if (typeof b.enabled !== 'boolean') return json({ error: 'enabled must be a boolean' }, { status: 400 })
          try {
            if (b.enabled) w.directService?.start()
            else w.directService?.stop()
          } catch (e) {
            return json({ error: (e as Error).message }, { status: 500 })
          }
          return json(w.directService?.status() ?? { enabled: false, port: null, addrs: [] })
        }
      }
      return new Response('not found', { status: 404 })
    },
  })
}

if (import.meta.main) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  // single instance: pid file. ponytail: tiny race if two start over a stale pid at once; use flock if it ever bites
  // mkdir is atomic: two hooks racing to start a watcher can't both win, and a crashed
  // instance's lock is reclaimed once its pid is gone.
  const pidFile = `${HOME}/watcher.pid`
  const lock = `${HOME}/watcher.lock`
  const alive = () => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); return true } catch { return false } }
  try { mkdirSync(lock) } catch {
    if (alive()) process.exit(0)
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock)
  }
  process.on('exit', () => { try { rmSync(lock, { recursive: true, force: true }) } catch {} })
  writeFileSync(pidFile, String(process.pid))
  try { unlinkSync(SOCK) } catch {}
  const w = new Watcher(`${HOME}/perch.db`)
  w.reconcile()
  serve(w)
  chmodSync(SOCK, 0o600) // only this user can inject prompts
  console.error(new Date().toISOString(), `watcher ${process.pid} listening on ${SOCK}`)
  // start syncing as soon as `perch pair` writes a config; restarting would cut off the sessions' waiters
  const cfgPath = `${HOME}/config.json`
  const tryStart = () => {
    if (!existsSync(cfgPath)) return
    clearInterval(timer)
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const keys = Keys.load(`${HOME}/key.json`)
    w.key = keys.pub
    w.machine = cfg.machine ?? hostname()
    w.directService = new DirectService(w, w.machine, keys)
    if (cfg.direct !== false) {
      try { w.directService.start() } catch (e) {
        console.error(new Date().toISOString(), 'direct listener failed:', (e as Error).message)
      }
    }
    console.error(new Date().toISOString(), `syncing with ${cfg.server}, key ${fingerprint(keys.pub)}`)
    w.sync(cfg, keys)
  }
  const timer = setInterval(tryStart, 5_000)
  tryStart()
}
