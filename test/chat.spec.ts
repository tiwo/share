import { describe, it, expect } from 'vitest'
import { parseChatMessage, createChatId } from '../src/lib/helpers'

describe('chat helpers', () => {
  it('createChatId returns a non-empty id', () => {
    const id = createChatId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('parses valid chat messages and rejects invalid ones', () => {
    const msg = { kind: 'CHAT_MSG', id: 'm-1', from: 'peerA', ts: Date.now(), text: 'hello' }
    const parsed = parseChatMessage(msg)
    expect(parsed).not.toBeNull()
    expect(parsed!.text).toBe('hello')

    expect(parseChatMessage(null)).toBeNull()
    expect(parseChatMessage({})).toBeNull()
    expect(parseChatMessage({ kind: 'CHAT_MSG', id: 1 })).toBeNull()
  })
})
