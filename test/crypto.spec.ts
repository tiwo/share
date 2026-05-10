import { describe, it, expect } from 'vitest'
import {
  normalizeFragment,
  generateSecret,
  decodeSecret,
  deriveRoomPeerId,
  createGuestPeerId,
  generateNonce,
  deriveAuthKey,
  signAuthPayload,
  secureEqual,
  createShareUrl,
} from '../src/lib/crypto'

describe('crypto utilities', () => {
  it('normalizes fragments', () => {
    expect(normalizeFragment('#abc')).toBe('abc')
    expect(normalizeFragment('  #xyz  ')).toBe('xyz')
    expect(normalizeFragment('plain')).toBe('plain')
  })

  it('generates and decodes secrets', () => {
    const secret = generateSecret()
    const decoded = decodeSecret(secret)
    expect(decoded).not.toBeNull()
    expect(decoded!.byteLength).toBe(18)
  })

  it('derives deterministic room peer id', async () => {
    const secret = generateSecret()
    const id1 = await deriveRoomPeerId(secret)
    const id2 = await deriveRoomPeerId(secret)
    expect(id1).toBe(id2)
    expect(id1.startsWith('share-room-')).toBe(true)
  })

  it('creates guest ids and nonces', () => {
    const guest = createGuestPeerId()
    expect(guest.startsWith('share-guest-')).toBe(true)

    const nonce = generateNonce(12)
    expect(typeof nonce).toBe('string')
    expect(nonce.length).toBeGreaterThan(0)
  })

  it('derives auth key and signs payloads', async () => {
    const secret = generateSecret()
    const key = await deriveAuthKey(secret)
    const sig = await signAuthPayload(key, 'hello')
    expect(typeof sig).toBe('string')
    expect(sig.length).toBeGreaterThan(0)

    expect(secureEqual('same', 'same')).toBe(true)
    expect(secureEqual('a', 'b')).toBe(false)
    expect(secureEqual('short', 'longer')).toBe(false)
  })

  it('createShareUrl uses window.location.href', () => {
    // stub window.location.href for Node test environment
    // @ts-ignore
    const oldWindow = global.window
    // @ts-ignore
    global.window = { location: { href: 'http://localhost/' } }
    const secret = generateSecret()
    const url = createShareUrl(secret)
    expect(url.includes(`#${secret}`)).toBe(true)
    // restore
    // @ts-ignore
    global.window = oldWindow
  })
})
