#!/usr/bin/env bun
// Claude Code hook entry: `bun hook.ts <start|stop|prompt|permission>`, hook JSON on stdin.
// Rule: never break the agent. Any failure → exit 0 with no output.
import { existsSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { HOME, SOCK } from './watcher'

const event = process.argv[2]
if (existsSync(`${HOME}/paused`)) process.exit(0) // pause switch: touch ~/.perch/paused

const call = async (path: string, body?: unknown, opts: { timeout?: number } = {}) => {
  const res = await fetch(`http://perch${path}`, {
    unix: SOCK,
    method: body ? 'POST' : 'GET',
    body: body && JSON.stringify(body),
    // Bun's fetch closes a socket idle for 5 minutes by default; 0 disables that idle timer.
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
  })
  return res.json() as Promise<any>
}

// Same default as the hook timeout written by `perch claude` (7 days).
const permissionSeconds = (() => {
  const n = Number(process.env.PERCH_PERMISSION_TIMEOUT)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 2_147_483) : 7 * 24 * 3600
})()

/// Ask in one-minute requests, reusing one request id. A lost reply, a timeout, or a watcher
/// restart just means the next request re-asks; the phone card stays the same one. After a
/// request that produced no decision, wait a jittered 1-10s before asking again.
async function permissionByPolling(req: {
  session_id: string; tool_name: unknown; tool_input: unknown; keys: string | null
}): Promise<any | null> {
  const request_id = crypto.randomUUID()
  const deadline = Date.now() + permissionSeconds * 1000
  while (Date.now() < deadline) {
    try {
      const res = await call('/hook/permission', { ...req, request_id, poll: true }, { timeout: 75_000 })
      if (res.request_id == null) return null // home: the terminal prompt handles it
      if (res.decision) return res.decision
      if (res.status === 'expired') return null
    } catch {}
    // The server held it for a minute and had no answer, or the request failed outright:
    // spread retries over 1-10s so a recovering watcher is not hammered.
    await Bun.sleep(1_000 + Math.floor(Math.random() * 9_001))
  }
  return null
}

async function ensureWatcher() {
  try { return await call('/status') } catch {}
  const log = openSync(`${HOME}/watcher.log`, 'a')
  spawn(process.execPath, [new URL('./watcher.ts', import.meta.url).pathname], { detached: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(100)
    try { return await call('/status') } catch {}
  }
}

try {
  const input = await Bun.stdin.json()
  const session_id = input.session_id
  // Empty for sessions launched outside `perch claude`; the watcher uses it to tell terminals apart.
  const keys = process.env.PERCH_KEYS ?? null
  const transcript = input.transcript_path ?? null
  switch (event) {
    case 'start':
      await ensureWatcher()
      await call('/hook/start', { session_id, cwd: input.cwd, keys, transcript, source: input.source })
      break
    case 'stop':
      await call('/hook/stop', { session_id, cwd: input.cwd, text: input.last_assistant_message ?? '', keys, transcript })
      break
    case 'prompt':
      await call('/hook/prompt', { session_id, cwd: input.cwd, text: input.prompt ?? '', keys, transcript })
      break
    case 'tool':
      await call('/hook/tool', {
        session_id, cwd: input.cwd, tool_name: input.tool_name, tool_input: input.tool_input, keys, transcript,
      })
      break
    case 'end':
      await call('/hook/end', { session_id, cwd: input.cwd, reason: input.reason ?? 'other', keys })
      break
    case 'permission': {
      await ensureWatcher()
      let protocol = 0
      try { protocol = Number((await call('/version')).protocol) || 0 } catch {}
      let decision: any = null
      if (protocol >= 3) {
        decision = await permissionByPolling({ session_id, tool_name: input.tool_name, tool_input: input.tool_input, keys })
      } else {
        // Older watcher: one blocking request. timeout: 0 disables Bun's 5-minute idle timer, or
        // it would close the request long before Claude Code's hook timeout.
        decision = (await call('/hook/permission', {
          session_id, tool_name: input.tool_name, tool_input: input.tool_input, keys,
        }, { timeout: 0 })).decision
      }
      if (decision) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
      break
    }
  }
} catch {}
process.exit(0)
