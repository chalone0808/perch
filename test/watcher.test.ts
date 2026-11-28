import { test, expect } from 'bun:test'
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Watcher, discoverCommands, retryDelay, serve, toDecision, toolSummary, taskNote, type Msg } from '../watcher'
import { Keys, fingerprint } from '../e2e'
import { VERSION, PROTOCOL } from '../version'

const msg = (type: string, body: any, session_id = 's1', id = crypto.randomUUID()): Msg => ({ id, type, session_id, body, ts: '' })
const out = (w: Watcher) => (w.db.query('select json from outbox order by seq').all() as { json: string }[]).map((r) => JSON.parse(r.json))
const settle = () => Bun.sleep(10)
// keep the developer's own ~/.claude out of the fixtures
const HOME = mkdtempSync(join(tmpdir(), 'perch-home-'))

// a watcher with one session whose terminal records every keystroke
const typing = ({ away = true } = {}) => {
  const w = new Watcher(':memory:', { home: HOME })
  const sent: string[] = []
  w.keyDelay = 0
  w.keys = async (_sock, data) => (sent.push(data), true)
  w.sessionStart({ session_id: 's1', cwd: '/x', keys: '/tmp/k.sock' })
  if (away) w.receive(msg('presence', { away: true }, null as any))
  return { w, sent }
}
const PASTE = (t: string) => `\x1b[200~${t}\x1b[201~`

test('version and protocol are reported locally and in sync', async () => {
  const w = new Watcher(':memory:', { home: HOME })
  expect(w.status()).toMatchObject({ version: VERSION, protocol: PROTOCOL })
  w.machine = 'test-machine'
  const sock = join(mkdtempSync(join(tmpdir(), 'perch-sock-')), 'watcher.sock')
  const server = serve(w, sock)
  try {
    const res = await fetch('http://perch/version', { unix: sock })
    expect(await res.json()).toMatchObject({
      name: 'perch', version: VERSION, protocol: PROTOCOL, machine: 'test-machine',
    })
  } finally { server.stop(true) }
})

test('failed syncs back off exponentially and cap out at a minute', () => {
  expect(retryDelay(1, () => 0)).toBe(1_000) // 2s base, half-jittered
  expect(retryDelay(1, () => 1)).toBe(2_000)
  expect(retryDelay(2, () => 0)).toBe(2_000)
  expect(retryDelay(3, () => 0)).toBe(4_000)
  expect(retryDelay(50, () => 1)).toBe(60_000) // a dead relay is retried once a minute, not hammered
  for (let n = 1; n <= 50; n++) {
    const delay = retryDelay(n, () => 0.5)
    expect(delay).toBeGreaterThanOrEqual(1_000)
    expect(delay).toBeLessThanOrEqual(60_000)
  }
})

test('away: a phone message is pasted into the terminal and submitted', async () => {
  const { w, sent } = typing()
  w.receive(msg('prompt', { text: 'line one\nline two' }))
  await settle()
  expect(sent).toEqual([PASTE('line one\nline two'), '\r'])
  expect(out(w).map((m) => m.type)).toContain('delivered')
})

test('home: messages wait, then go out merged in order when switched to away', async () => {
  const { w, sent } = typing({ away: false })
  w.receive(msg('prompt', { text: 'one' }))
  w.receive(msg('prompt', { text: 'two' }))
  await settle()
  expect(sent).toEqual([])
  w.receive(msg('presence', { away: true }, null as any))
  await settle()
  expect(sent).toEqual([PASTE('one\n\ntwo'), '\r'])
})

// A terminal that records into a real transcript file like Claude Code: [take] decides, per Enter,
// whether the typed text lands (as a queued message when [busy]).
const recording = (take: (enter: number) => boolean, busy = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'perch-tx-'))
  const transcript = join(dir, 's1.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n')
  const w = new Watcher(':memory:', { home: HOME })
  const sent: string[] = []
  let pasted = ''
  let enters = 0
  w.keyDelay = 0
  w.acceptWait = 100
  w.keys = async (_sock, data) => {
    sent.push(data)
    if (data.startsWith('\x1b[200~')) pasted = data.slice(6, -6)
    if (data === '\r' && take(++enters)) {
      const line = busy
        ? { type: 'queue-operation', operation: 'enqueue', content: pasted }
        : { type: 'user', message: { role: 'user', content: pasted } }
      appendFileSync(transcript, JSON.stringify(line) + '\n')
    }
    return true
  }
  w.sessionStart({ session_id: 's1', cwd: '/x', keys: '/tmp/k.sock', transcript })
  w.receive(msg('presence', { away: true }, null as any))
  return { w, sent }
}

test('delivered means Claude Code took it: idle prompt or mid-turn queue entry', async () => {
  for (const busy of [false, true]) {
    const { w, sent } = recording(() => true, busy)
    w.receive(msg('prompt', { text: 'check  the\nlogs' }))
    await Bun.sleep(50)
    expect(sent.filter((k) => k === '\r')).toHaveLength(1)
    expect(out(w).map((m) => m.type)).toContain('delivered')
  }
})

test('a swallowed Enter is pressed again; text Claude Code never takes is reported, not delivered', async () => {
  const retried = recording((enter) => enter === 2)
  retried.w.receive(msg('prompt', { text: 'second try' }))
  await Bun.sleep(300)
  expect(retried.sent.filter((k) => k === '\r')).toHaveLength(2)
  expect(out(retried.w).map((m) => m.type)).toContain('delivered')

  const lost = recording(() => false)
  lost.w.receive(msg('prompt', { text: 'into the void' }))
  await Bun.sleep(400)
  const types = out(lost.w).map((m) => m.type)
  expect(types).not.toContain('delivered')
  expect(out(lost.w).find((m) => m.type === 'delivery_failed').body.error).toBe('not taken')
})

test('phone text cannot escape the paste to press keys', async () => {
  const { w, sent } = typing()
  w.receive(msg('prompt', { text: 'hi\x1b[201~\r\x03' }))
  await settle()
  expect(sent[0]).toBe(PASTE('hi[201~'))
})

test('laptop prompts are reported; the echo of a phone-typed prompt is not', async () => {
  const { w } = typing()
  w.receive(msg('prompt', { text: 'from phone' }))
  await settle()
  w.userPrompt({ session_id: 's1', cwd: '/x', text: 'from phone' }) // UserPromptSubmit echo
  expect(out(w).filter((m) => m.type === 'user_prompt')).toEqual([])

  w.userPrompt({ session_id: 's1', cwd: '/x', text: 'typed at the laptop' })
  expect(out(w).find((m) => m.type === 'user_prompt').body).toEqual({ cwd: '/x', text: 'typed at the laptop' })
})

test('background task notifications are notes, not laptop prompts', () => {
  const { w } = typing()
  const raw = `<task-notification>
<task-id>b69uwjcjn</task-id>
<status>completed</status>
<summary>Background command "Run the tests" completed (exit code 0)</summary>
</task-notification>`
  w.userPrompt({ session_id: 's1', cwd: '/x', text: raw })
  expect(out(w).filter((m) => m.type === 'user_prompt')).toEqual([])
  expect(out(w).find((m) => m.type === 'task_note')?.body).toEqual({
    cwd: '/x',
    status: 'completed',
    summary: 'Background command "Run the tests" completed (exit code 0)',
  })

  expect(taskNote('typed by a person')).toBeNull()
  expect(taskNote('<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>'))
    .toEqual({ status: 'unknown', summary: 'Stop hook feedback' })
  expect(taskNote('<task-notification><status>failed</status><result>boom</result></task-notification>'))
    .toEqual({ status: 'failed', summary: 'boom' })
})

test('repeated message ids are ignored', async () => {
  const { w, sent } = typing()
  const m = msg('prompt', { text: 'once' })
  w.receive(m)
  w.receive(m)
  await settle()
  expect(sent).toEqual([PASTE('once'), '\r'])
})

test('approvals: home → terminal; away → phone decides; a message meanwhile denies with that text', async () => {
  const { w, sent } = typing({ away: false })
  expect(await w.permission({ session_id: 's1', tool_name: 'Bash', tool_input: {} })).toBeNull()

  w.receive(msg('presence', { away: true }, null as any))
  const p1 = w.permission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } })
  const req = out(w).find((m) => m.type === 'needs_attention')
  w.receive(msg('decision', { request_id: req.body.request_id, behavior: 'allow' }))
  expect(await p1).toEqual({ behavior: 'allow' })

  const p2 = w.permission({ session_id: 's1', tool_name: 'Bash', tool_input: {} })
  w.receive(msg('prompt', { text: 'use git instead' }))
  expect(await p2).toEqual({ behavior: 'deny', message: 'use git instead' })
  expect(sent).toEqual([]) // never typed into the open dialog
})

test('an approval that timed out closes on the phone and blocks typing until the turn ends', async () => {
  const { w, sent } = typing()
  const ctrl = new AbortController()
  w.permission({ session_id: 's1', tool_name: 'Bash', tool_input: {} }, ctrl.signal)
  const request_id = out(w).find((m) => m.type === 'needs_attention').body.request_id
  ctrl.abort() // hook timeout: dialog left open in the terminal
  expect(out(w).find((m) => m.type === 'request_expired').body).toEqual({ request_id })

  w.receive(msg('prompt', { text: 'later' }))
  w.receive(msg('command', { text: '/compact' }))
  await settle()
  expect(sent).toEqual([])
  expect(out(w).find((m) => m.type === 'command_result').body.ok).toBe(false)

  await w.stop({ session_id: 's1', cwd: '/x', text: 'done' })
  expect(sent).toEqual([PASTE('later'), '\r'])
})

test('an approval hook that expires after the turn ended does not block typing', async () => {
  const { w, sent } = typing()
  const ctrl = new AbortController()
  w.permission({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }, ctrl.signal)
  await w.stop({ session_id: 's1', cwd: '/x', text: 'done' })
  ctrl.abort() // the hook outlives its turn (answered in the terminal), then expires
  expect(w.status().blocked).toEqual([])

  w.receive(msg('prompt', { text: 'next' }))
  await settle()
  expect(sent).toContainEqual(PASTE('next'))
})

test('a prompt typed at the terminal unblocks queued phone messages', async () => {
  const { w, sent } = typing()
  const ctrl = new AbortController()
  w.permission({ session_id: 's1', tool_name: 'Bash', tool_input: {} }, ctrl.signal)
  ctrl.abort() // hands the dialog to the terminal: typing stays off
  w.receive(msg('prompt', { text: 'later' }))
  await settle()
  expect(sent).toEqual([])

  w.userPrompt({ session_id: 's1', cwd: '/x', text: 'typed at the terminal' })
  await settle()
  expect(sent).toEqual([PASTE('later'), '\r'])
})

test('an answer that arrives after the request expired is reported as invalid', () => {
  const { w } = typing()
  const ctrl = new AbortController()
  w.permission({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS }, ctrl.signal)
  const request_id = out(w).find((m) => m.type === 'needs_attention').body.request_id
  ctrl.abort()

  const late = msg('decision', { request_id, behavior: 'allow', answers: { 'Which DB?': 'SQLite' } })
  w.receive(late)
  expect(out(w).find((m) => m.type === 'decision_result').body).toEqual({
    ref: late.id,
    ok: false,
    error: 'request expired',
  })
})

test('switching to Home hands a pending approval back to the terminal', async () => {
  const { w, sent } = typing()
  const pending = w.permission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } })
  const request_id = out(w).find((m) => m.type === 'needs_attention').body.request_id

  w.receive(msg('presence', { away: false }, null as any))
  expect(await pending).toBeNull() // no decision: Claude Code shows its own prompt
  expect(out(w).find((m) => m.type === 'request_expired')?.body).toEqual({ request_id })

  const late = msg('decision', { request_id, behavior: 'allow' })
  w.receive(late)
  expect(out(w).find((m) => m.type === 'decision_result')?.body).toEqual({
    ref: late.id,
    ok: false,
    error: 'request expired',
  })

  // Home keeps phone text for later; it goes out when the machine is Away again
  w.receive(msg('prompt', { text: 'later' }))
  await settle()
  expect(sent).toEqual([])
  await w.stop({ session_id: 's1', cwd: '/x', text: 'done' })
  expect(sent).toEqual([])
  w.receive(msg('presence', { away: true }, null as any))
  await settle()
  expect(sent).toEqual([PASTE('later'), '\r'])
})

test('compact completion is reported and does not replay the compacted history', async () => {
  const { appendFileSync, mkdtempSync } = await import('node:fs')
  const t = `${mkdtempSync('/tmp/perch-t-')}/t.jsonl`
  const line = (text: string) => appendFileSync(t, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n')
  line('old history')

  const { w } = typing()
  w.sessionStart({ session_id: 's1', cwd: '/x', keys: '/tmp/k.sock', transcript: t, source: 'compact' })
  expect(out(w).filter((m) => m.type === 'agent_reply')).toEqual([])

  const compact = out(w).find((m) => m.type === 'compact')!
  expect(compact.notify).toBe(true)

  line('Still reading after the compaction.')
  w.activity({ session_id: 's1', cwd: '/x', tool_name: 'Read', tool_input: {}, transcript: t })
  expect(out(w).filter((m) => m.type === 'agent_reply').map((m) => m.body.text))
    .toEqual(['Still reading after the compaction.'])
})

test('only away replies and notes ask the relay for a push', async () => {
  const away = typing()
  await away.w.stop({ session_id: 's1', cwd: '/x', text: 'done' })
  expect(out(away.w).find((m) => m.type === 'agent_reply')?.notify).toBe(true)

  const home = typing({ away: false })
  await home.w.stop({ session_id: 's1', cwd: '/x', text: 'done' })
  expect(out(home.w).find((m) => m.type === 'agent_reply')?.notify).toBeUndefined()

  away.w.userPrompt({ session_id: 's1', cwd: '/x', text: '<task-notification><status>completed</status><summary>Build done</summary></task-notification>' })
  expect(out(away.w).find((m) => m.type === 'task_note')?.notify).toBe(true)
})

test('text between tool calls pushes while away and stays quiet at home', async () => {
  const { appendFileSync, mkdtempSync } = await import('node:fs')
  const transcript = (name: string) => {
    const t = `${mkdtempSync(`/tmp/perch-${name}-`)}/t.jsonl`
    writeFileSync(t, '')
    return t
  }
  const text = (t: string, body: string) => appendFileSync(t, JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: body }] },
  }) + '\n')

  for (const away of [true, false]) {
    const { w } = typing({ away })
    const t = transcript(away ? 'away' : 'home')
    w.sessionStart({ session_id: 's1', cwd: '/x', keys: '/tmp/k.sock', transcript: t })
    text(t, 'Still working.')
    w.activity({ session_id: 's1', cwd: '/x', tool_name: 'Read', tool_input: {}, transcript: t })
    const reply = out(w).find((m) => m.type === 'agent_reply' && m.body.text === 'Still working.')
    expect(reply?.body).toEqual({ text: 'Still working.', partial: true })
    expect(reply?.notify).toBe(away ? true : undefined)
  }
})

test('session gone: delivery fails visibly', async () => {
  const { w } = typing()
  w.keys = async () => { throw new Error('ECONNREFUSED') }
  w.receive(msg('prompt', { text: 'hello?' }))
  await settle()
  expect(out(w).find((m) => m.type === 'delivery_failed').body.error).toBe('session ended')
})

test('interrupt presses Esc in the session terminal', async () => {
  const { w, sent } = typing()
  w.receive(msg('interrupt', {}))
  await settle()
  expect(sent).toEqual(['\x1b'])
})

test('commands: only single-line slash commands get typed', async () => {
  const { w, sent } = typing()
  w.receive(msg('command', { text: '/compact' }))
  w.receive(msg('command', { text: '/compact\nrm -rf ~' }))
  await settle()
  expect(sent).toEqual(['/compact', '\r'])
})

test('commands: discovers user and project skills and nested command files', () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-project-'))
  const home = mkdtempSync(join(tmpdir(), 'perch-home-'))
  mkdirSync(join(root, '.claude/skills/liquid-glass'), { recursive: true })
  writeFileSync(join(root, '.claude/skills/liquid-glass/SKILL.md'),
    '---\nname: liquid-glass\ndescription: Glass rules\n---\nbody')
  mkdirSync(join(root, '.claude/skills/hidden'), { recursive: true })
  writeFileSync(join(root, '.claude/skills/hidden/SKILL.md'),
    '---\nname: hidden\ndescription: Not for people\nuser-invocable: false\n---\n')
  mkdirSync(join(root, '.claude/commands/db'), { recursive: true })
  writeFileSync(join(root, '.claude/commands/db/migrate.md'), '---\ndescription: Migrate  the database\n---\n')
  mkdirSync(join(home, '.claude/commands'), { recursive: true })
  writeFileSync(join(home, '.claude/commands/deploy.md'), '---\ndescription: Ship it\n---\n')

  expect(discoverCommands(root, home)).toEqual([
    { name: 'db:migrate', description: 'Migrate the database' },
    { name: 'deploy', description: 'Ship it' },
    { name: 'liquid-glass', description: 'Glass rules' },
  ])
})

test('session start publishes the session commands once, then only on change', () => {
  const root = mkdtempSync(join(tmpdir(), 'perch-project-'))
  const home = mkdtempSync(join(tmpdir(), 'perch-home-'))
  mkdirSync(join(root, '.claude/commands'), { recursive: true })
  writeFileSync(join(root, '.claude/commands/deploy.md'), '---\ndescription: Ship it\n---\n')

  const w = new Watcher(':memory:', { home })
  w.sessionStart({ session_id: 's1', cwd: root, keys: null })
  const first = out(w).filter((m) => m.type === 'commands')
  expect(first).toHaveLength(1)
  expect(first[0].body).toEqual({ commands: [{ name: 'deploy', description: 'Ship it' }] })

  w.userPrompt({ session_id: 's1', cwd: root, text: 'hello' })
  expect(out(w).filter((m) => m.type === 'commands')).toHaveLength(1)

  writeFileSync(join(root, '.claude/commands/release.md'), '---\ndescription: Cut a release\n---\n')
  w.stop({ session_id: 's1', cwd: root, text: 'done' })
  expect(out(w).filter((m) => m.type === 'commands')).toHaveLength(2)
})

test('no launcher socket: interrupt reports failure', async () => {
  const w = new Watcher(':memory:', { home: HOME })
  w.sessionStart({ session_id: 's1', cwd: '/x', keys: null })
  w.receive(msg('interrupt', {}))
  await settle()
  expect(out(w).find((m) => m.type === 'interrupted').body.ok).toBe(false)
})

test('sync: encrypted both ways; unsealed or stranger messages are dropped', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const mk = () => new Keys(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as any)
  const phone = mk(), stranger = mk(), machine = mk()
  const { w, sent } = typing()
  await w.stop({ session_id: 's1', cwd: '/x', text: 'done' })
  const down = (k: Keys, text: string) => { const m = msg('prompt', { text }); return { ...m, body: k.seal('down', m, [machine.pub]) } }
  const seen: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = await req.json()
      seen.push(b)
      const phones = [{ name: 'iPhone', pubkey: phone.pub }]
      if (seen.length === 1) {
        return Response.json({
          acked: [], cursor: 7, phones,
          inbox: [down(stranger, 'evil'), msg('prompt', { text: 'plain' }), down(phone, 'from phone')],
        })
      }
      if (seen.length === 2) return Response.json({ acked: b.outbox.map((m: Msg) => m.id), inbox: [], cursor: 7, phones })
      await Bun.sleep(50)
      return Response.json({ acked: [], inbox: [], cursor: 7, phones })
    },
  })
  w.sync({ server: `http://localhost:${server.port}`, token: 't' }, machine)
  while (seen.length < 3) await Bun.sleep(5)
  server.stop(true)
  expect(sent).toEqual([PASTE('from phone'), '\r'])
  expect(seen[0].outbox).toEqual([]) // no phone keys yet: nothing to seal for
  expect(seen[0].pubkey).toBe(machine.pub)
  expect(seen[0].version).toBe(VERSION)
  expect(seen[0].protocol).toBe(PROTOCOL)
  const reply = seen[1].outbox.find((m: Msg) => m.type === 'agent_reply')
  expect(JSON.stringify(reply.body)).not.toContain('done')
  expect(phone.open('up', reply, [machine.pub])?.body).toEqual({ cwd: '/x', text: 'done' })
  expect(phone.open('up', { ...reply, session_id: 's2' }, [machine.pub])).toBeNull() // moved to another session
  // An away reply carries a separately sealed preview for the notification; it can't pass as the body.
  expect(phone.open('push', { ...reply, body: reply.preview }, [machine.pub])?.body).toEqual({ cwd: '/x', text: 'done' })
  expect(phone.open('up', { ...reply, body: reply.preview }, [machine.pub])).toBeNull()
  expect(seen[1].outbox.find((m: Msg) => m.type === 'session_start').preview).toBeUndefined()
  expect(seen[1].after).toBe(7)
  expect(w.status().phones).toEqual([{ name: 'iPhone', key: fingerprint(phone.pub) }])
})

test('push previews: one line for pushed messages only', () => {
  const { w } = typing()
  const p = (type: string, body: any, extra: Partial<Msg> = {}) => w.pushPreview({ ...msg(type, body), ...extra })
  expect(p('agent_reply', { cwd: '/w/app', text: 'Tests pass.\n\nPushed.' }, { notify: true })).toEqual({ cwd: '/w/app', text: 'Tests pass. Pushed.' })
  expect(p('agent_reply', { text: 'partial' })).toBeNull() // no push, no preview
  expect(p('needs_attention', { request_id: 'r1', tool_name: 'Bash', tool_input: { command: 'git push' } }))
    .toEqual({ cwd: '/x', text: 'Bash: git push', request_id: 'r1', kind: 'permission' })
  expect(p('needs_attention', { request_id: 'r2', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which DB?' }] } }))
    .toMatchObject({ text: 'Which DB?', kind: 'question' })
  expect(p('needs_attention', { request_id: 'r3', tool_name: 'ExitPlanMode', tool_input: { plan: '\n## Ship it\n- step' } }))
    .toMatchObject({ text: 'Plan: Ship it', kind: 'plan', request_id: 'r3' })
  expect(p('needs_attention', { tool_name: 'Bash', tool_input: {} }, { snapshot: true })).toBeNull()
  expect(p('task_note', { summary: 'Tests done' }, { notify: true })).toEqual({ cwd: '/x', text: 'Tests done' })
  // No text, but still a preview: it carries the sealed session for grouping and tapping.
  expect(p('compact', {}, { notify: true })).toEqual({ cwd: '/x', text: '' })
  expect(p('agent_reply', { text: 'x'.repeat(500) }, { notify: true })?.text.length).toBe(200)
})

test('sync: phones that read e2e 2 get session and time sealed inside; the rest keep v1', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const mk = () => new Keys(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as any)
  const phone = mk(), oldPhone = mk(), machine = mk()
  const { w, sent } = typing()
  await w.stop({ session_id: 's1', cwd: '/x', text: 'done' })
  const m = msg('prompt', { text: 'v2 prompt' })
  const down = phone.sealMessage('down', m, [machine.pub], 2)
  const seen: any[] = []
  let phones: any[] = [{ name: 'new', pubkey: phone.pub, e2e: 2 }]
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = await req.json()
      seen.push(b)
      if (seen.length === 1) return Response.json({ acked: [], cursor: 1, phones, inbox: [down] })
      if (seen.length === 3) phones = [...phones, { name: 'old', pubkey: oldPhone.pub }]
      if (seen.length > 4) await Bun.sleep(50)
      return Response.json({ acked: [], inbox: [], cursor: 1, phones })
    },
  })
  w.sync({ server: `http://localhost:${server.port}`, token: 't' }, machine)
  while (seen.length < 5) await Bun.sleep(5)
  server.stop(true)
  expect(seen[0].e2e).toBe(2) // the laptop reports what it reads
  expect(down).not.toHaveProperty('session_id')
  expect(sent).toEqual([PASTE('v2 prompt'), '\r']) // the session came out of the seal
  const reply = seen[1].outbox.find((x: Msg) => x.type === 'agent_reply')
  expect(reply).not.toHaveProperty('session_id')
  expect(reply).not.toHaveProperty('ts')
  expect(phone.openMessage('up', reply, [machine.pub])).toMatchObject({ session_id: 's1', body: { cwd: '/x', text: 'done' } })
  // Once a phone that only reads v1 joins, everything goes out as v1 again.
  const forOld = seen.slice(3).flatMap((b) => b.outbox).filter((x: any) => x.body?.to?.[oldPhone.pub])
  expect(forOld.length).toBeGreaterThan(0) // its live snapshot
  expect(forOld.every((x: any) => x.body.e2e === 1 && x.session_id !== undefined)).toBe(true)
})

test('a newly paired phone gets a live snapshot sealed only to it', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const mk = () => new Keys(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as any)
  const oldPhone = mk(), newPhone = mk(), machine = mk()
  const { w } = typing()
  w.db.run('delete from outbox')
  w.perms.set('req1', { session: 's1', tool: 'Bash', input: { command: 'ls' }, resolve: () => {} })
  w.set('phones', JSON.stringify([{ name: 'old', pubkey: oldPhone.pub }]))

  const seen: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = await req.json()
      seen.push(b)
      const phones = seen.length === 1
        ? [{ name: 'old', pubkey: oldPhone.pub }]
        : [{ name: 'old', pubkey: oldPhone.pub }, { name: 'new', pubkey: newPhone.pub }]
      return Response.json({ acked: b.outbox.map((m: Msg) => m.id), inbox: [], cursor: 1, phones })
    },
  })
  w.sync({ server: `http://localhost:${server.port}`, token: 't' }, machine)
  while (seen.length < 3) await Bun.sleep(5)
  server.stop(true)

  const snap = seen[2].outbox as Msg[]
  expect(snap.map((m) => m.type).sort()).toEqual(['commands', 'needs_attention', 'presence', 'session_start'])
  expect(snap.every((m) => m.to?.length === 1 && m.to[0] === newPhone.pub && m.snapshot === true)).toBe(true)

  const start = snap.find((m) => m.type === 'session_start')!
  const opened = newPhone.open('up', start, [machine.pub])?.body as any
  expect(opened).toMatchObject({ cwd: '/x' })
  expect(typeof opened.machine).toBe('string')
  expect(oldPhone.open('up', start, [machine.pub])).toBeNull()

  const attention = snap.find((m) => m.type === 'needs_attention')!
  expect(attention.session_id).toBe('s1')
  const openedAttention = newPhone.open('up', attention, [machine.pub])?.body as any
  expect(openedAttention.request_id).toBe('req1')
})

const QUESTIONS = {
  questions: [
    { question: 'Which DB?', header: 'DB', options: [{ label: 'SQLite' }, { label: 'Postgres' }], multiSelect: false },
    { question: 'Which tests?', header: 'Tests', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true },
  ],
}

test('questions: answers are merged into the original input; unknown or forged fields are ignored', () => {
  const d = toDecision('AskUserQuestion', QUESTIONS, {
    behavior: 'allow',
    answers: { 'Which DB?': 'Postgres', 'Which tests?': 'unit, e2e', 'Injected?': 'x' },
    updated_input: { questions: [] }, // a phone can't replace the input
  })
  expect(d).toEqual({ behavior: 'allow', updatedInput: { ...QUESTIONS, answers: { 'Which DB?': 'Postgres', 'Which tests?': 'unit, e2e' } } })
})

test('plan: approve echoes the plan; auto-accept edits is the strongest mode a phone can set', () => {
  const plan = { plan: '## Plan', planFilePath: '/p.md' }
  expect(toDecision('ExitPlanMode', plan, { behavior: 'allow' })).toEqual({ behavior: 'allow', updatedInput: plan })
  expect(toDecision('ExitPlanMode', plan, { behavior: 'allow', mode: 'acceptEdits' }).updatedPermissions)
    .toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
  expect(toDecision('ExitPlanMode', plan, { behavior: 'allow', mode: 'bypassPermissions' }).updatedPermissions).toBeUndefined()
  expect(toDecision('ExitPlanMode', plan, { behavior: 'deny', message: 'add tests first' }))
    .toEqual({ behavior: 'deny', message: 'add tests first' })
})

test('tool activity: a compact, one-line summary and a detail, never the whole input', async () => {
  const { w } = typing()
  w.activity({
    session_id: 's1',
    cwd: '/x',
    tool_name: 'Bash',
    tool_input: { command: 'flutter test\n  --coverage', description: 'Run the tests' },
  })
  const a = out(w).find((m) => m.type === 'activity')
  expect(a.body).toEqual({ cwd: '/x', tool: 'Bash', summary: 'Run the tests', detail: 'flutter test\n  --coverage' })

  const edit = toolSummary('Edit', { file_path: '/w/app/lib/main.dart', old_string: 'secret', new_string: 'x' })
  expect(edit).toEqual({ tool: 'Edit', summary: 'main.dart', detail: '/w/app/lib/main.dart' })
  expect(toolSummary('Write', { file_path: '/w/notes.txt', content: 'secret' }).detail).toBe('/w/notes.txt')
  expect(toolSummary('NotebookEdit', { notebook_path: '/w/nb.ipynb', new_source: 'secret' }).summary).toBe('nb.ipynb')
  expect(toolSummary('Grep', { pattern: 'TODO', path: 'lib' }).summary).toBe('TODO')
})

test('a new session in the same terminal ends the old one and fails its queued messages', async () => {
  const { w, sent } = typing({ away: false })
  w.receive(msg('prompt', { text: 'for the old session' }))
  w.userPrompt({ session_id: 's1', cwd: '/x', text: 'laptop prompt' })
  w.sessionStart({ session_id: 's2', cwd: '/x', keys: '/tmp/k.sock' }) // `/resume` in the same terminal
  await settle()
  expect(sent).toEqual([])
  expect(out(w).find((m) => m.type === 'session_end')).toMatchObject({ session_id: 's1', body: { reason: 'replaced' } })
  expect(out(w).find((m) => m.type === 'delivery_failed').body.ids).toHaveLength(1)
  const old = w.db.query('select keys from sessions where id = ?').get('s1') as any
  expect(old.keys).toBeNull() // nothing more will be typed into the switched terminal
})

test('startup reconcile ends dead sessions and old sessions sharing a live terminal', () => {
  const w = new Watcher(':memory:', { home: HOME })
  const live = `/tmp/perch-live-${crypto.randomUUID()}` // no pid suffix, so only existence is checked
  writeFileSync(live, '')
  w.sessionStart({ session_id: 'dead', cwd: '/x', keys: '/tmp/perch-socket-that-does-not-exist' })
  w.sessionStart({ session_id: 'old', cwd: '/x', keys: live })
  w.db.run(`update sessions set updated = '2020-01-01T00:00:00.000Z' where id = 'old'`)
  w.sessionStart({ session_id: 'new', cwd: '/x', keys: live }) // resumed later in the same terminal
  w.reconcile()
  expect(out(w).filter((m) => m.type === 'session_end').map((m) => m.session_id).sort()).toEqual(['dead', 'old'])
  expect((w.db.query('select keys from sessions where id = ?').get('new') as any).keys).toBe(live)
})

test('SessionEnd ends the session; an ended session ignores a repeated end', () => {
  const { w } = typing({ away: false })
  expect(w.endFromHook({ session_id: 's1', reason: 'prompt_input_exit', keys: '/tmp/k.sock' })).toBe(true)
  expect(w.endFromHook({ session_id: 's1', reason: 'other', keys: '/tmp/k.sock' })).toBe(false) // already ended
  expect(out(w).filter((m) => m.type === 'session_end')).toHaveLength(1)
  expect((w.db.query('select keys from sessions where id = ?').get('s1') as any).keys).toBeNull()
})

test('SessionEnd from another terminal cannot end a live session', () => {
  const { w } = typing({ away: false })
  expect(w.endFromHook({ session_id: 's1', reason: 'other', keys: '/tmp/other.sock' })).toBe(false)
  expect(w.endFromHook({ session_id: 's1', reason: 'other', keys: null })).toBe(false)
  expect((w.db.query('select keys from sessions where id = ?').get('s1') as any).keys).toBe('/tmp/k.sock')
  expect(out(w).filter((m) => m.type === 'session_end')).toEqual([])
})

test('a decision for an AskUserQuestion request reaches the hook with the answers', async () => {
  const { w } = typing()
  const pending = w.permission({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: QUESTIONS })
  const req = out(w).find((m) => m.type === 'needs_attention')
  w.receive(msg('decision', { request_id: req.body.request_id, behavior: 'allow', answers: { 'Which DB?': 'SQLite' } }))
  expect((await pending)?.updatedInput).toEqual({ ...QUESTIONS, answers: { 'Which DB?': 'SQLite' } })
})

test('direct addresses are classified by network and never include public or loopback hosts', async () => {
  const { directAddrs } = await import('../watcher')
  expect(directAddrs({
    en0: [{ address: '192.168.1.24', family: 'IPv4', internal: false }],
    utun3: [{ address: '100.120.43.88', family: 'IPv4', internal: false }],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth1: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
  } as any)).toEqual([
    { host: '192.168.1.24', network: 'lan' },
    { host: '100.120.43.88', network: 'tailscale' },
  ])
})

test('sync advertises the direct port and addresses, and null when disabled', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const key = new Keys(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as any)
  const { w } = typing()
  w.db.run('delete from outbox')
  w.set('phones', JSON.stringify([{ name: 'iPhone', pubkey: key.pub }]))
  w.addresses = () => [{ host: '192.168.1.24', network: 'lan' }]
  w.directPort = 8789
  const seen: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) { seen.push(await req.json()); return Response.json({ acked: [], inbox: [], cursor: 0, phones: [] }) },
  })
  w.sync({ server: `http://localhost:${server.port}`, token: 't', machine: 'mac' }, key)
  while (seen.length < 1) await Bun.sleep(5)
  expect(seen[0].direct).toEqual({ port: 8789, addrs: expect.any(Array) })
  w.directPort = undefined
  w.onOutbox() // cut the in-flight long-poll so the next request carries direct: null
  while (seen.length < 2) await Bun.sleep(5)
  expect(seen[1].direct).toBeNull()
  server.stop(true)
})

test('text between tool calls reaches the phone once, the final reply once', async () => {
  const { appendFileSync, mkdtempSync } = await import('node:fs')
  const t = `${mkdtempSync('/tmp/perch-t-')}/t.jsonl`
  const line = (type: string, content: any, extra = {}) => appendFileSync(t, JSON.stringify({ type, message: { content }, ...extra }) + '\n')
  line('assistant', [{ type: 'text', text: 'old history' }])
  const { w } = typing()
  w.sessionStart({ session_id: 's1', cwd: '/x', keys: '/tmp/k.sock', transcript: t })
  line('user', 'do it')
  line('assistant', [{ type: 'text', text: 'Let me look first.' }])
  line('assistant', [{ type: 'tool_use', name: 'Read', input: {} }])
  w.activity({ session_id: 's1', cwd: '/x', tool_name: 'Read', tool_input: {}, transcript: t })
  line('assistant', [{ type: 'text', text: 'subagent' }], { isSidechain: true })
  line('assistant', [{ type: 'text', text: 'Found it, fixing.' }])
  await w.stop({ session_id: 's1', cwd: '/x', text: 'Done.', transcript: t }) // final not written yet
  line('assistant', [{ type: 'text', text: 'Done.' }])
  w.userPrompt({ session_id: 's1', cwd: '/x', text: 'next', transcript: t })
  const replies = out(w).filter((m) => m.type === 'agent_reply').map((m) => [m.body.text, !!m.body.partial])
  expect(replies).toEqual([['Let me look first.', true], ['Found it, fixing.', true], ['Done.', false]])
})

test('prompts wait out a plan dialog and flush when it closes', async () => {
  const { w, sent } = typing()
  w.activity({ session_id: 's1', cwd: '/x', tool_name: 'ExitPlanMode', tool_input: {}, keys: '/tmp/k.sock' })
  w.receive(msg('prompt', { text: 'held' }))
  await settle()
  const state = () => (w.db.query(`select state from inbox where type = 'prompt'`).get() as any).state
  expect(sent).toEqual([]) // the dialog would swallow a pasted prompt
  expect(state()).toBe('queued')
  // The dialog closed and an ordinary tool runs: queued input is safe again.
  w.activity({ session_id: 's1', cwd: '/x', tool_name: 'Bash', tool_input: {}, keys: '/tmp/k.sock' })
  await settle()
  expect(sent).toEqual([PASTE('held'), '\r'])
  expect(state()).toBe('delivered')
})

test('a question picker holds prompts until the turn ends', async () => {
  const { w, sent } = typing()
  w.activity({ session_id: 's1', cwd: '/x', tool_name: 'AskUserQuestion', tool_input: {}, keys: '/tmp/k.sock' })
  w.receive(msg('prompt', { text: 'later' }))
  await settle()
  expect(sent).toEqual([])
  await w.stop({ session_id: 's1', cwd: '/x', text: '', keys: '/tmp/k.sock' })
  expect(sent).toEqual([PASTE('later'), '\r'])
})

test('sync stores the relay cursor token and device id, then sends them back', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const machine = new Keys(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as any)
  const w = new Watcher(':memory:', { home: HOME })
  const seen: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(await req.json())
      if (seen.length === 1) return Response.json({ acked: [], inbox: [], cursor: 5, phones: [], cursor_token: 'r:d:5', device_id: 'dev_abc' })
      await Bun.sleep(50)
      return Response.json({ acked: [], inbox: [], cursor: 5, phones: [] })
    },
  })
  w.sync({ server: `http://localhost:${server.port}`, token: 't' }, machine)
  while (seen.length < 2) await Bun.sleep(5)
  server.stop(true)
  expect(seen[0].protocol).toBe(2)
  expect(seen[0].cursor_token).toBeUndefined()
  expect(seen[1].cursor_token).toBe('r:d:5')
  expect(seen[1].after).toBe(5)
  expect(w.machineId).toBe('dev_abc')
  expect(w.get('device_id')).toBe('dev_abc')
  expect(w.get('cursor_token')).toBe('r:d:5')
})
