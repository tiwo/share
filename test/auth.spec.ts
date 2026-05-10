import { describe, it, expect, beforeEach } from 'vitest'
import AuthManager from '../src/lib/auth'
import { generateSecret } from '../src/lib/crypto'

function makePair(secret: string) {
  const a = new AuthManager(secret, 'A')
  const b = new AuthManager(secret, 'B')

  // wire senders
  a.setSender((m) => setTimeout(() => void b.handleMessage(m as any), 0))
  b.setSender((m) => setTimeout(() => void a.handleMessage(m as any), 0))

  return { a, b }
}

describe('AuthManager handshake', () => {
  it('authenticates two sides with same secret', async () => {
    const secret = generateSecret()
    const { a, b } = makePair(secret)

    let aDone = false
    let bDone = false

    a.onAuthenticated(() => {
      aDone = true
    })
    b.onAuthenticated(() => {
      bDone = true
    })

    a.setSender((m) => setTimeout(() => void b.handleMessage(m as any), 0))
    b.setSender((m) => setTimeout(() => void a.handleMessage(m as any), 0))

    await a.start()

    // wait a bit
    await new Promise((r) => setTimeout(r, 500))

    expect(a.state).toBe('authenticated')
    expect(b.state).toBe('authenticated')
    expect(aDone).toBe(true)
    expect(bDone).toBe(true)
  })
})
