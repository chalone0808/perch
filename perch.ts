#!/usr/bin/env bun
// perch claude [args...]       start claude with phone hooks attached (this launch only)
// perch pair <server> <code>    connect this laptop to a relay (code from the phone: Settings -> Add a Laptop)
// perch unpair                 remove this laptop from the relay (local history stays here)
// perch update                 git pull this client checkout, then reload the watcher
// perch restart                reload the watcher after updating perch (agents keep running)
// perch status                 sessions, queues, presence
// perch version                client and relay versions
// perch direct on|off|status   turn the direct phone endpoint on or off, or show its state
// perch away | home            presence: away = approvals go to the phone
// perch send <session> <text>  inject a phone message locally (testing without a server)
import { mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, openSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { HOME, SOCK } from './watcher'
import { Keys, fingerprint } from './e2e'
import { relayFetch } from './net'
import { VERSION, PROTOCOL } from './version'

const [cmd, ...args] = process.argv.slice(2)
// How long a phone approval stays answerable. Seven days by default; override with
// PERCH_PERMISSION_TIMEOUT (seconds). JS timers top out just under 24.8 days.
const MAX_HOOK_TIMEOUT = Math.floor(2_147_483_647 / 1000)
const permissionTimeout = (() => {
  const n = Number(process.env.PERCH_PERMISSION_TIMEOUT)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_HOOK_TIMEOUT) : 7 * 24 * 3600
})()
const hook = (event: string) => `"${process.execPath}" "${new URL('./hook.ts', import.meta.url).pathname}" ${event}`
const call = (path: string, body?: unknown) =>
  fetch(`http://perch${path}`, { unix: SOCK, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) })
    .then((r) => r.json())
    .catch(() => { console.error('watcher not running (it starts with the first `perch claude` session)'); process.exit(1) })
const readConfig = (): any | null => {
  try { return JSON.parse(readFileSync(`${HOME}/config.json`, 'utf8')) } catch { return null }
}
const callOrNull = (path: string, body?: unknown) =>
  fetch(`http://perch${path}`, { unix: SOCK, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)

switch (cmd) {
  case 'claude': {
    mkdirSync(HOME, { recursive: true, mode: 0o700 })
    const settings = `${HOME}/hooks.json`
    writeFileSync(settings, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: hook('start') }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: hook('end') }] }],
        Stop: [{ hooks: [{ type: 'command', command: hook('stop') }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('prompt') }] }],
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hook('tool'), timeout: 10 }] }],
        // Longest a phone answer can take: 7 days by default. After that the hook is cancelled, the
        // terminal prompt takes over, and the phone is told the request expired. Switching to Home
        // releases pending requests to the terminal immediately.
        PermissionRequest: [{ hooks: [{ type: 'command', command: hook('permission'), timeout: permissionTimeout }] }],
      },
    }, null, 2))
    // Run claude in a pseudo-terminal we own (like tmux does), so the phone can press Esc or type /compact.
    mkdirSync(`${HOME}/keys`, { recursive: true, mode: 0o700 })
    const keysSock = `${HOME}/keys/${process.pid}.sock`
    const { stdin, stdout } = process
    const proc = Bun.spawn(['claude', '--settings', settings, ...args], {
      env: { ...process.env, PERCH_KEYS: keysSock },
      terminal: { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24, data: (_t, d) => stdout.write(d) },
    })
    const term = proc.terminal!
    const keys = Bun.serve({ unix: keysSock, fetch: async (req) => (term.write(await req.text()), new Response('ok')) })
    chmodSync(keysSock, 0o600) // only this user can type into the session
    if (stdin.isTTY) stdin.setRawMode(true) // pass every key through untouched, including Ctrl+C
    stdin.on('data', (d) => term.write(d))
    stdout.on('resize', () => term.resize(stdout.columns, stdout.rows))
    const code = await proc.exited
    if (stdin.isTTY) stdin.setRawMode(false)
    keys.stop(true)
    rmSync(keysSock, { force: true })
    process.exit(code)
  }
  case 'restart':
    if (!(await restartWatcher())) process.exit(1)
    break
  case 'update': {
    // Pull the latest client into this checkout, then reload what runs from it. The relay is a
    // separate install and updates from its own repository.
    const repo = import.meta.dir
    const git = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, ...a], { stdout: 'pipe', stderr: 'pipe' })
    // A `--source` install is a copied tree with no .git. Without this check, git can silently
    // walk up to an unrelated parent repository and pull that instead.
    const inside = git('rev-parse', '--is-inside-work-tree')
    if (!existsSync(`${repo}/.git`) || inside.exitCode !== 0 || inside.stdout.toString().trim() !== 'true') {
      console.error(`${repo} is not a git checkout; rerun the installer to update`)
      process.exit(1)
    }
    const before = git('rev-parse', 'HEAD').stdout.toString().trim()
    const pull = git('pull', '--ff-only')
    if (pull.exitCode !== 0) {
      console.error(`git pull failed in ${repo}:\n${pull.stderr.toString().trim()}`)
      process.exit(1)
    }
    const after = git('rev-parse', 'HEAD').stdout.toString().trim()
    if (before === after) { console.log('already up to date'); break }
    const changed = git('diff', '--name-only', before, after).stdout.toString().split('\n')
    console.log(git('log', '--oneline', `${before}..${after}`).stdout.toString().trim())
    if (changed.some((f) => f.endsWith('.ts')) && existsSync(SOCK)) await restartWatcher()
    console.log('running `perch claude` sessions pick up hook changes when restarted')
    break
  }
  case 'status':
    console.log(JSON.stringify(await call('/status'), null, 2))
    break
  case 'version': {
    let local = await callOrNull('/version')
    if (!local) {
      const running = (await callOrNull('/status')) != null
      local = {
        name: 'perch',
        version: VERSION,
        protocol: PROTOCOL,
        running,
        note: running
          ? 'the running watcher is older and does not report a version; restart it'
          : 'the watcher is not running; this is the installed client',
      }
    }
    const cfg = readConfig()
    let relay: any = null
    if (cfg?.server) {
      const server = String(cfg.server).replace(/\/$/, '')
      try {
        const res = await relayFetch(`${server}/v1/version`)
        relay = res.ok ? await res.json() : { server, error: `HTTP ${res.status}` }
      } catch (e) {
        relay = { server, error: (e as Error).message }
      }
    }
    console.log(JSON.stringify({ client: local, relay }, null, 2))
    break
  }
  case 'away':
  case 'home':
    await call('/inject', { type: 'presence', body: { away: cmd === 'away' } })
    console.log(cmd)
    break
  case 'pair': {
    const [server, code] = args
    if (!server || !code) { console.error('usage: perch pair <server url> <code>'); process.exit(1) }
    const machine = hostname()
    mkdirSync(HOME, { recursive: true, mode: 0o700 })
    const keys = Keys.load(`${HOME}/key.json`)
    const res = await relayFetch(`${server.replace(/\/$/, '')}/v1/pair`, { method: 'POST', body: JSON.stringify({ code, name: machine, pubkey: keys.pub }) })
    const out = (await res.json()) as any
    if (!res.ok || out.kind !== 'machine') { console.error('pairing failed:', out.error ?? `not a machine code (${out.kind})`); process.exit(1) }
    mkdirSync(HOME, { recursive: true, mode: 0o700 })
    // Re-pairing keeps a direct opt-out: pairing again should only replace the relay credentials.
    const previous = readConfig()
    const config: any = { server: server.replace(/\/$/, ''), token: out.token, machine }
    if (previous?.direct === false) config.direct = false
    writeFileSync(`${HOME}/config.json`, JSON.stringify(config, null, 2), { mode: 0o600 })
    console.log(`paired as "${machine}", key ${fingerprint(keys.pub)}`)
    // A running watcher keeps the config it started with. Reload it so a re-pair switches now,
    // without making the user discover that `perch pair` alone left it on the old relay.
    if (existsSync(SOCK)) await restartWatcher()
    break
  }
  case 'unpair': {
    const cfg = readConfig()
    if (!cfg?.server || !cfg?.token) { console.error('not paired'); process.exit(1) }
    const server = String(cfg.server).replace(/\/$/, '')
    let res: Response
    try {
      res = await relayFetch(`${server}/v1/unpair`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: '{}',
      })
    } catch (e) {
      console.error(`unpair failed: ${(e as Error).message}`)
      process.exit(1)
    }
    // A phone can revoke this computer first. The relay then answers 401, which means the token is
    // already dead: clear the local side too instead of leaving a pairing that can never sync.
    const alreadyGone = res.status === 401
    if (!res.ok && !alreadyGone) {
      const out = (await res.json().catch(() => ({}))) as any
      console.error('unpair failed:', out.error ?? `HTTP ${res.status}`)
      process.exit(1)
    }
    await stopWatcher()
    rmSync(`${HOME}/config.json`, { force: true })
    console.log(alreadyGone
      ? 'this computer was already unpaired; local config removed'
      : `unpaired "${cfg.machine ?? hostname()}"; keys and local history stay on this computer`)
    break
  }
  case 'send':
    if (args.length < 2) { console.error('usage: perch send <session_id> <text>'); process.exit(1) }
    await call('/inject', { type: 'prompt', session_id: args[0], body: { text: args.slice(1).join(' ') } })
    console.log('queued')
    break
  case 'direct': {
    const sub = args[0]
    const cfg = readConfig()
    if (sub === 'status') {
      const status = await callOrNull('/status')
      console.log(JSON.stringify({ configured: cfg ? cfg.direct !== false : false, running: status?.direct ?? null }, null, 2))
      break
    }
    if (sub !== 'on' && sub !== 'off') { console.error('usage: perch direct on|off|status'); process.exit(1) }
    if (!cfg) { console.error('not paired yet'); process.exit(1) }
    cfg.direct = sub === 'on'
    writeFileSync(`${HOME}/config.json`, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    const status = await callOrNull('/direct', { enabled: cfg.direct })
    console.log(`direct ${sub}${status ? '' : ' (saved; applies when the watcher starts)'}`)
    break
  }
  default:
    console.error('usage: perch claude [args] | pair <server> <code> | unpair | direct on|off|status | update | restart | status | version | away | home | send <session> <text>')
    process.exit(1)
}

async function restartWatcher() {
  // Reload the watcher after `git pull`. Agents keep running; a pending approval falls back to
  // the terminal prompt, so the command warns first.
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const status = (await fetch('http://perch/status', { unix: SOCK }).then((r) => r.json()).catch(() => null)) as any
  if (status?.pending_approvals) {
    console.error(`${status.pending_approvals} approval(s) waiting: they fall back to the terminal prompt.`)
  }
  await stopWatcher()
  const log = openSync(`${HOME}/watcher.log`, 'a')
  spawn(process.execPath, [new URL('./watcher.ts', import.meta.url).pathname], {
    detached: true, stdio: ['ignore', log, log],
  }).unref()
  let up = false
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100)
    try {
      if ((await fetch('http://perch/status', { unix: SOCK })).ok) { up = true; break }
    } catch {}
  }
  console.log(up ? 'watcher restarted' : `watcher did not start; see ${HOME}/watcher.log`)
  return up
}

/// Stop the running watcher, if it is ours. Agents keep running; their hooks lose the phone until
/// a new watcher starts. A stale pid (SIGKILLed watcher) is never killed because the pid can be
/// reused; only a process whose command line names watcher.ts is touched.
async function stopWatcher(): Promise<boolean> {
  const pidFile = `${HOME}/watcher.pid`
  let pid = 0
  try { pid = Number(readFileSync(pidFile, 'utf8')) } catch {}
  const isWatcher = (p: number) => {
    try { return Bun.spawnSync(['ps', '-p', String(p), '-o', 'command=']).stdout.toString().includes('watcher.ts') } catch { return false }
  }
  if (!pid || !isWatcher(pid)) {
    rmSync(`${HOME}/watcher.lock`, { recursive: true, force: true }) // stale lock would keep a new watcher from starting
    return false
  }
  try { process.kill(pid) } catch {}
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  for (let i = 0; i < 50 && alive(); i++) await Bun.sleep(100)
  return true
}
