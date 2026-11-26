// Requests from the laptop to the relay. Some networks (AMD's corporate DNS, for one) NXDOMAIN
// the relay's domain even though public DNS resolves it and the server is reachable.
//
// The system resolver is always tried first. Only when it can't resolve the name (ENOTFOUND) is
// the name looked up over DNS-over-HTTPS, and the request sent to that address with the real
// name kept for TLS (SNI and the certificate check) and the Host header, so nothing is trusted
// that the system path wouldn't trust. The address is reused for the record's TTL, so the
// long-poll loop doesn't repeat a failing lookup every round.
//
// PERCH_DOH sets the DoH endpoint (JSON API); set it empty (PERCH_DOH=) to turn the fallback off.
export const DOH = process.env.PERCH_DOH ?? 'https://1.1.1.1/dns-query'

type Get = (url: string, init?: any) => Promise<Response>
type Init = RequestInit & { tls?: Record<string, unknown> }

const pinned = new Map<string, { addr: string; until: number }>()

// The first A record, else the first AAAA record (bracketed for use in a URL), or null.
export async function lookupDoh(host: string, doh = DOH, get: Get = fetch): Promise<{ addr: string; ttl: number } | null> {
  for (const [type, code] of [['A', 1], ['AAAA', 28]] as const) {
    const res = await get(`${doh}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`DoH lookup of ${host} via ${doh}: HTTP ${res.status}`)
    const { Answer = [] } = (await res.json()) as { Answer?: { type: number; data: string; TTL: number }[] }
    const hit = Answer.find((a) => a.type === code) // skips the CNAME records that precede it
    if (hit) return { addr: code === 1 ? hit.data : `[${hit.data}]`, ttl: hit.TTL }
  }
  return null
}

export async function relayFetch(url: string, init: Init = {}, doh = DOH, get: Get = fetch): Promise<Response> {
  const u = new URL(url)
  let pin = doh ? pinned.get(u.hostname) : undefined
  if (!pin || pin.until < Date.now()) {
    pinned.delete(u.hostname)
    try {
      return await get(url, init)
    } catch (e) {
      if (!doh || (e as { code?: string }).code !== 'ENOTFOUND') throw e
    }
    const found = await lookupDoh(u.hostname, doh, get)
    if (!found) throw new Error(`${u.hostname} does not resolve, neither through system DNS nor ${doh}`)
    pin = { addr: found.addr, until: Date.now() + Math.min(Math.max(found.ttl, 60), 3600) * 1000 }
    pinned.set(u.hostname, pin)
    console.error(new Date().toISOString(), `system DNS can't resolve ${u.hostname}; using ${found.addr} from ${doh}`)
  }
  const target = new URL(url)
  target.hostname = pin.addr
  const headers = new Headers(init.headers)
  headers.set('host', u.host)
  try {
    return await get(target.href, { ...init, headers, tls: { ...init.tls, serverName: u.hostname } })
  } catch (e) {
    if (!init.signal?.aborted) pinned.delete(u.hostname) // the address may have moved: look it up again next time
    throw e
  }
}
