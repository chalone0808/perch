import { test, expect } from 'bun:test'
import { relayFetch, lookupDoh } from '../net'

const DOH = 'https://doh.test/dns-query'
const notFound = () => Object.assign(new TypeError('Unable to connect'), { code: 'ENOTFOUND' })

// A fake fetch: the relay's name doesn't resolve, DoH answers with `answers[type]`, the address works.
const fakeNet = (answers: Record<string, unknown[]>, opts: { addrFails?: boolean } = {}) => {
  const calls: { url: string; init: any }[] = []
  const get = async (url: string, init: any = {}) => {
    calls.push({ url, init })
    const u = new URL(url)
    if (u.host === 'doh.test') return Response.json({ Answer: answers[u.searchParams.get('type')!] ?? [] })
    if (/^[\d.]+$|^\[/.test(u.hostname)) {
      if (opts.addrFails) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
      return new Response('ok')
    }
    throw notFound()
  }
  return { calls, get }
}

test('uses system DNS when it resolves, without touching DoH', async () => {
  const calls: string[] = []
  const res = await relayFetch('https://ok.example/v1/sync', {}, DOH, async (url) => (calls.push(url), new Response('direct')))
  expect(await res.text()).toBe('direct')
  expect(calls).toEqual(['https://ok.example/v1/sync'])
})

test('on ENOTFOUND, connects to the DoH address with the real name for TLS and Host', async () => {
  const net = fakeNet({ A: [{ type: 5, data: 'cdn.example.', TTL: 600 }, { type: 1, data: '203.0.113.7', TTL: 600 }] })
  const res = await relayFetch('https://blocked.example/v1/sync', { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'x' }, DOH, net.get)
  expect(await res.text()).toBe('ok')
  const last = net.calls.at(-1)!
  expect(last.url).toBe('https://203.0.113.7/v1/sync')
  expect(last.init.tls.serverName).toBe('blocked.example')
  expect(last.init.headers.get('host')).toBe('blocked.example')
  expect(last.init.headers.get('authorization')).toBe('Bearer t')
  expect(last.init.method).toBe('POST')
  expect(last.init.body).toBe('x')

  // pinned for the TTL: the next request goes straight to the address
  const before = net.calls.length
  await relayFetch('https://blocked.example/v1/sync', {}, DOH, net.get)
  expect(net.calls.slice(before).map((c) => c.url)).toEqual(['https://203.0.113.7/v1/sync'])

  // with DoH off, the pinned address isn't used either
  await expect(relayFetch('https://blocked.example/v1/sync', {}, '', net.get)).rejects.toThrow('Unable to connect')
})

test('keeps a non-default port in the Host header and falls back to AAAA', async () => {
  const net = fakeNet({ AAAA: [{ type: 28, data: '2001:db8::1', TTL: 60 }] })
  await relayFetch('https://v6only.example:8443/v1/pair', {}, DOH, net.get)
  const last = net.calls.at(-1)!
  expect(last.url).toBe('https://[2001:db8::1]:8443/v1/pair')
  expect(last.init.headers.get('host')).toBe('v6only.example:8443')
})

test('drops the pinned address when connecting to it fails', async () => {
  const net = fakeNet({ A: [{ type: 1, data: '203.0.113.8', TTL: 600 }] }, { addrFails: true })
  await expect(relayFetch('https://moved.example/', {}, DOH, net.get)).rejects.toThrow('refused')
  const before = net.calls.length
  await expect(relayFetch('https://moved.example/', {}, DOH, net.get)).rejects.toThrow('refused')
  expect(net.calls[before].url).toBe('https://moved.example/') // system DNS tried again, not the stale address
})

test('other errors, an empty PERCH_DOH and an empty DoH answer are not papered over', async () => {
  const refused = async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }
  await expect(relayFetch('https://down.example/', {}, DOH, refused)).rejects.toThrow('refused')
  await expect(relayFetch('https://off.example/', {}, '', fakeNet({}).get)).rejects.toThrow('Unable to connect')
  await expect(relayFetch('https://nxdomain.example/', {}, DOH, fakeNet({}).get)).rejects.toThrow('does not resolve')
  expect(await lookupDoh('nxdomain.example', DOH, fakeNet({}).get)).toBeNull()
})
