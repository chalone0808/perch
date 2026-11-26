import { test, expect } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Watcher, directHandler, type Msg } from '../watcher'
import { Keys, directRequestProof, directResponseProof, sameProof } from '../e2e'

const mk = () => new Keys(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as any)
const msg = (type: string, body: any, session_id = 's1', id = crypto.randomUUID()): Msg => ({ id, type, session_id, body, ts: '' })

const setup = () => {
  const phone = mk(), machine = mk()
  const w = new Watcher(':memory:', { home: mkdtempSync(join(tmpdir(), 'perch-direct-')) })
  const sent: string[] = []
  w.keyDelay = 0
  w.keys = async (_sock, data) => (sent.push(data), true)
  w.sessionStart({ session_id: 's1', cwd: '/x', keys: '/tmp/k.sock' })
  w.receive(msg('presence', { away: true }, null as any))
  w.set('phones', JSON.stringify([{ name: 'iPhone', pubkey: phone.pub }]))
  w.db.run('delete from outbox')
  const handle = directHandler(w, { machine: 'mac', keys: machine })
  const request = (body: any, opts: { ts?: string; nonce?: string; key?: Buffer; phone?: string; machine?: string } = {}) => {
    const raw = JSON.stringify(body)
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000))
    const nonce = opts.nonce ?? crypto.randomUUID()
    const key = opts.key ?? phone.directKey(machine.pub)
    return new Request('http://laptop/v1/direct/sync', {
      method: 'POST',
      headers: {
        'x-perch-phone': opts.phone ?? phone.pub,
        'x-perch-ts': ts,
        'x-perch-nonce': nonce,
        'x-perch-auth': directRequestProof(key, 'POST', '/v1/direct/sync', ts, nonce, raw),
      },
      body: raw,
    })
  }
  return { w, phone, machine, sent, handle, request }
}

test('a signed phone message is delivered and acknowledged', async () => {
  const { w, phone, machine, sent, handle, request } = setup()
  const m = msg('prompt', { text: 'carry on' })
  m.machine = 'mac'
  const res = await handle(request({ after: 0, outbox: [{ ...m, body: phone.seal('down', m, [machine.pub]) }], wait: 0 }), '192.168.1.9')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ acked: [m.id] })
  await Bun.sleep(20)
  expect(sent).toContain('\x1b[200~carry on\x1b[201~')
})

test('bad key, stale timestamp, replay and public peers are rejected', async () => {
  const { phone, machine, handle, request } = setup()
  expect((await handle(request({ after: 0 }, { key: mk().directKey(machine.pub) }), '192.168.1.9')).status).toBe(401)
  expect((await handle(request({ after: 0 }, { ts: '1' }), '192.168.1.9')).status).toBe(401)
  const nonce = crypto.randomUUID()
  expect((await handle(request({ after: 0 }, { nonce }), '192.168.1.9')).status).toBe(200)
  expect((await handle(request({ after: 0 }, { nonce }), '192.168.1.9')).status).toBe(401)
  expect((await handle(request({ after: 0 }), '8.8.8.8')).status).toBe(403)
})

test('messages for another machine are ignored', async () => {
  const { phone, machine, handle, request } = setup()
  const other = msg('prompt', { text: 'no' })
  other.machine = 'other'
  const res = await handle(request({ after: 0, outbox: [{ ...other, body: phone.seal('down', other, [machine.pub]) }], wait: 0 }), '192.168.1.9')
  expect((await res.json()).acked).toEqual([])
})

test('inbox is sealed for the phone with a signed response', async () => {
  const { w, phone, machine, handle } = setup()
  w.emit('agent_reply', 's1', { text: 'done' })
  const nonce = crypto.randomUUID()
  const raw = JSON.stringify({ after: 0, wait: 0 })
  const ts = String(Math.floor(Date.now() / 1000))
  const req = new Request('http://laptop/v1/direct/sync', {
    method: 'POST',
    headers: {
      'x-perch-phone': phone.pub, 'x-perch-ts': ts, 'x-perch-nonce': nonce,
      'x-perch-auth': directRequestProof(phone.directKey(machine.pub), 'POST', '/v1/direct/sync', ts, nonce, raw),
    },
    body: raw,
  })
  const res = await handle(req, '192.168.1.9')
  const text = await res.text()
  expect(sameProof(res.headers.get('x-perch-auth')!, directResponseProof(phone.directKey(machine.pub), nonce, text))).toBe(true)
  const body = JSON.parse(text)
  expect(body.cursor).toBeGreaterThan(0)
  expect(phone.open('up', body.inbox[0], [machine.pub])?.body).toEqual({ text: 'done' })
})

test('direct inbox entries carry the machine, like the relay adds', async () => {
  const { w, phone, machine, handle, request } = setup()
  w.emit('agent_reply', 's1', { text: 'done' })
  const res = await handle(request({ after: 0, wait: 0 }), '192.168.1.9')
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.inbox[0]).toMatchObject({ type: 'agent_reply', session_id: 's1', machine: 'mac' })
  // The body is still sealed; only the routing envelope gained the machine.
  expect(phone.open('up', body.inbox[0], [machine.pub])?.body).toEqual({ text: 'done' })
})

test('DirectService opens a port and closes it on stop', async () => {
  const { w, machine } = setup()
  const { DirectService } = await import('../watcher')
  const svc = new DirectService(w, 'mac', machine, 0)
  svc.start()
  expect(svc.listening).toBe(true)
  expect(w.directPort).toBeGreaterThan(0)
  svc.stop()
  expect(svc.listening).toBe(false)
  expect(w.directPort).toBeUndefined()
})

test('a new outbox message wakes a direct long-poll', async () => {
  const { w, handle, request } = setup()
  const started = Date.now()
  const waiting = handle(request({ after: 0, wait: 10 }), '192.168.1.9')
  await Bun.sleep(50)
  w.emit('agent_reply', 's1', { text: 'wake' })
  const res = await waiting
  expect(res.status).toBe(200)
  expect(Date.now() - started).toBeLessThan(2000)
})

test('a phone that reads e2e 2 gets the session sealed inside, both ways', async () => {
  const { w, phone, machine, sent, handle, request } = setup()
  w.set('phones', JSON.stringify([{ name: 'iPhone', pubkey: phone.pub, e2e: 2 }]))
  w.emit('agent_reply', 's1', { text: 'done' })
  const m = { ...msg('prompt', { text: 'v2 direct' }), machine: 'mac' }
  const res = await handle(request({ after: 0, wait: 0, outbox: [phone.sealMessage('down', m, [machine.pub], 2)] }), '192.168.1.9')
  const body = (await res.json()) as any
  expect(body.acked).toEqual([m.id])
  await Bun.sleep(20)
  expect(sent).toContain('\x1b[200~v2 direct\x1b[201~')
  expect(body.inbox[0]).not.toHaveProperty('session_id')
  expect(phone.openMessage('up', body.inbox[0], [machine.pub])).toMatchObject({ session_id: 's1', machine: 'mac', body: { text: 'done' } })
})
