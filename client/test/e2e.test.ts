import { test, expect } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { Keys, directRequestProof, directResponseProof, sameProof } from '../e2e'

const mk = () => new Keys(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as any)

test('both ends derive the same direct key, separate from the message key', () => {
  const a = mk(), b = mk(), c = mk()
  const ab = a.directKey(b.pub).toString('hex')
  expect(ab).toBe(b.directKey(a.pub).toString('hex'))
  expect(ab).not.toBe(a.directKey(c.pub).toString('hex'))
})

test('request and response proofs are bound to every field', () => {
  const a = mk(), b = mk()
  const key = a.directKey(b.pub)
  const proof = directRequestProof(key, 'POST', '/v1/direct/sync', '1700000000', 'n1', '{"a":1}')
  expect(sameProof(proof, directRequestProof(key, 'POST', '/v1/direct/sync', '1700000000', 'n1', '{"a":1}'))).toBe(true)
  expect(sameProof(proof, directRequestProof(key, 'POST', '/v1/direct/sync', '1700000001', 'n1', '{"a":1}'))).toBe(false)
  expect(sameProof(proof, directRequestProof(key, 'POST', '/v1/direct/sync', '1700000000', 'n2', '{"a":1}'))).toBe(false)
  expect(sameProof(proof, directRequestProof(key, 'POST', '/v1/direct/sync', '1700000000', 'n1', '{"a":2}'))).toBe(false)

  const r1 = directResponseProof(key, 'n1', '{"ok":true}')
  expect(sameProof(r1, directResponseProof(key, 'n1', '{"ok":true}'))).toBe(true)
  expect(sameProof(r1, directResponseProof(key, 'n2', '{"ok":true}'))).toBe(false)
  expect(sameProof(r1, 'not-a-proof')).toBe(false)
})

test('v2 seals session_id and ts with the body; the envelope keeps only routing fields', () => {
  const phone = mk(), machine = mk()
  const m = { id: 'm1', type: 'agent_reply', session_id: 's1', ts: '2026-11-25T00:00:00Z', body: { text: 'hi' }, notify: true }
  const sent = machine.sealMessage('up', m, [phone.pub], 2)
  expect(sent).not.toHaveProperty('session_id')
  expect(sent).not.toHaveProperty('ts')
  expect(sent.body.e2e).toBe(2)
  expect(JSON.stringify(sent)).not.toContain('s1')
  expect(phone.openMessage('up', sent, [machine.pub])).toEqual({ ...m, body: { text: 'hi' } })
  // The id, type and direction are bound: the relay can't move the body to another message.
  expect(phone.openMessage('up', { ...sent, id: 'm2' }, [machine.pub])).toBeNull()
  expect(phone.openMessage('up', { ...sent, type: 'task_note' }, [machine.pub])).toBeNull()
  expect(phone.openMessage('down', sent, [machine.pub])).toBeNull()
  // A session_id the relay adds to the envelope is ignored in favour of the sealed one.
  expect(phone.openMessage('up', { ...sent, session_id: 'evil' }, [machine.pub])?.session_id).toBe('s1')
})

test('v1 still seals the body alone, with the session in the associated data', () => {
  const phone = mk(), machine = mk()
  const m = { id: 'm1', type: 'prompt', session_id: 's1', ts: 't', body: { text: 'go' } }
  const sent = phone.sealMessage('down', m, [machine.pub], 1)
  expect(sent).toMatchObject({ session_id: 's1', ts: 't' })
  expect(machine.openMessage('down', sent, [phone.pub])).toEqual(m)
  expect(machine.openMessage('down', { ...sent, session_id: 's2' }, [phone.pub])).toBeNull()
})
