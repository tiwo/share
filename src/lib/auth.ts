import type { DataConnection } from 'peerjs'
import {
  deriveAuthKey,
  generateNonce,
  secureEqual,
  signAuthPayload,
} from './crypto'

export type AuthState = 'idle' | 'in-progress' | 'authenticated' | 'failed'

type AuthHelloMessage = {
  kind: 'AUTH_HELLO'
  attempt: number
  from: string
  nonce: string
  ts: number
}

type AuthProofMessage = {
  kind: 'AUTH_PROOF'
  attempt: number
  from: string
  nonce: string
  peerNonce: string
  ts: number
  peerTs: number
  mac: string
}

type AuthAckMessage = {
  kind: 'AUTH_ACK'
  attempt: number
  from: string
  proofMac: string
  mac: string
}

type AuthFailMessage = {
  kind: 'AUTH_FAIL'
  attempt: number
  from: string
  reason: string
}

export type AuthMessage = AuthHelloMessage | AuthProofMessage | AuthAckMessage | AuthFailMessage

export interface AuthOptions {
  maxAttempts?: number
  replayWindowMs?: number
  nonceCacheTtlMs?: number
  attemptTimeoutMs?: number
}

export class AuthManager {
  public state: AuthState = 'idle'
  public lastFailure = ''
  public attempt = 0
  public nonceCache = new Map<string, number>()

  private secret: string
  private selfId: string
  private authKey: CryptoKey | null = null
  private localHello: AuthHelloMessage | null = null
  private remoteHello: AuthHelloMessage | null = null
  private sentProofMac = ''
  private sentProof = false
  private peerProofVerified = false
  private peerAckVerified = false
  private opts: Required<AuthOptions>
  private connectionSend: ((msg: unknown) => void) | null = null
  private onAuthenticatedCb: (() => void) | null = null
  private onFailedCb: ((reason: string) => void) | null = null
  private attemptTimer: ReturnType<typeof setTimeout> | null = null

  constructor(secret: string, selfId: string, opts?: AuthOptions) {
    this.secret = secret
    this.selfId = selfId
    this.opts = Object.assign(
      { maxAttempts: 3, replayWindowMs: 90_000, nonceCacheTtlMs: 10 * 60_000, attemptTimeoutMs: 9_000 },
      opts || {},
    )
  }

  public async initKey(): Promise<void> {
    if (!this.authKey) this.authKey = await deriveAuthKey(this.secret)
  }

  public onAuthenticated(cb: () => void): void {
    this.onAuthenticatedCb = cb
  }

  public onFailed(cb: (reason: string) => void): void {
    this.onFailedCb = cb
  }

  public setSender(fn: (msg: unknown) => void): void {
    this.connectionSend = fn
  }

  public clearNonceCache(): void {
    this.nonceCache.clear()
  }

  private pruneNonceCache(): void {
    const now = Date.now()
    for (const [k, v] of this.nonceCache.entries()) {
      if (v <= now) this.nonceCache.delete(k)
    }
  }

  private rememberNonce(nonce: string): boolean {
    this.pruneNonceCache()
    if (this.nonceCache.has(nonce)) return false
    this.nonceCache.set(nonce, Date.now() + this.opts.nonceCacheTtlMs)
    return true
  }

  private isFreshTimestamp(ts: number): boolean {
    return Math.abs(Date.now() - ts) <= this.opts.replayWindowMs
  }

  private makeProofPayload(sender: AuthHelloMessage, receiver: AuthHelloMessage, attempt: number): string {
    return ['proof', attempt, sender.from, receiver.from, sender.nonce, receiver.nonce, sender.ts, receiver.ts].join('|')
  }

  private makeAckPayload(senderPeerId: string, receiverPeerId: string, attempt: number, proofMac: string): string {
    return ['ack', attempt, senderPeerId, receiverPeerId, proofMac].join('|')
  }

  private async signPayload(payload: string): Promise<string> {
    if (!this.authKey) await this.initKey()
    return signAuthPayload(this.authKey as CryptoKey, payload)
  }

  private cleanupAttemptTimer(): void {
    if (this.attemptTimer !== null) {
      clearTimeout(this.attemptTimer)
      this.attemptTimer = null
    }
  }

  private async failAttempt(reason: string): Promise<void> {
    this.cleanupAttemptTimer()
    this.lastFailure = reason
    this.state = 'in-progress'
    if (this.onFailedCb) this.onFailedCb(reason)

    if (this.attempt >= this.opts.maxAttempts) {
      this.state = 'failed'
      if (this.onFailedCb) this.onFailedCb(reason)
      return
    }

    const delay = 400 * Math.pow(2, Math.max(0, this.attempt - 1))
    setTimeout(() => {
      if (this.connectionSend) this.start()
    }, delay)
  }

  public async start(): Promise<void> {
    if (!this.connectionSend) throw new Error('Sender not set')
    this.attempt += 1
    this.localHello = { kind: 'AUTH_HELLO', attempt: this.attempt, from: this.selfId, nonce: generateNonce(12), ts: Date.now() }
    this.state = 'in-progress'
    this.connectionSend(this.localHello)
    this.attemptTimer = setTimeout(() => {
      void this.failAttempt('Authentication timed out')
    }, this.opts.attemptTimeoutMs)
  }

  public async handleMessage(msg: AuthMessage): Promise<void> {
    if (!this.connectionSend) throw new Error('Sender not set')

    if (msg.kind === 'AUTH_FAIL') {
      this.lastFailure = msg.reason
      return
    }

    if (msg.attempt < this.attempt) return

    if (msg.kind === 'AUTH_HELLO') {
      if (!this.isFreshTimestamp(msg.ts)) {
        await this.failAttempt('Stale hello timestamp')
        return
      }
      if (!this.rememberNonce(msg.nonce)) {
        await this.failAttempt('Replay detected: nonce already seen')
        return
      }
      this.remoteHello = msg
      // if we haven't sent our hello yet, start now
      if (!this.localHello) await this.start()
      // if both hello present, send proof
      await this.sendProofIfReady()
      return
    }

    if (!this.localHello || !this.remoteHello) {
      await this.failAttempt('Incomplete auth state for verification')
      return
    }

    if (msg.kind === 'AUTH_PROOF') {
      if (msg.from !== this.remoteHello.from) {
        await this.failAttempt('Proof sender mismatch')
        return
      }
      if (msg.nonce !== this.remoteHello.nonce || msg.peerNonce !== this.localHello.nonce) {
        await this.failAttempt('Proof nonce mismatch')
        return
      }

      const expected = await this.signPayload(this.makeProofPayload(this.remoteHello, this.localHello, this.attempt))
      if (!secureEqual(msg.mac, expected)) {
        await this.failAttempt('Proof MAC mismatch')
        return
      }

      this.peerProofVerified = true
      // send ack
      const ackPayload = this.makeAckPayload(this.selfId, this.remoteHello.from, this.attempt, msg.mac)
      const ackMac = await this.signPayload(ackPayload)
      const ack: AuthAckMessage = { kind: 'AUTH_ACK', attempt: this.attempt, from: this.selfId, proofMac: msg.mac, mac: ackMac }
      this.connectionSend(ack)
      this.maybeFinalize()
      return
    }

    if (msg.kind === 'AUTH_ACK') {
      if (msg.from !== this.remoteHello.from) {
        await this.failAttempt('ACK sender mismatch')
        return
      }
      if (!this.sentProofMac || msg.proofMac !== this.sentProofMac) {
        await this.failAttempt('ACK proof mismatch')
        return
      }
      const expectedAck = await this.signPayload(this.makeAckPayload(this.remoteHello.from, this.selfId, this.attempt, this.sentProofMac))
      if (!secureEqual(msg.mac, expectedAck)) {
        await this.failAttempt('ACK MAC mismatch')
        return
      }
      this.peerAckVerified = true
      this.maybeFinalize()
      return
    }
  }

  private async sendProofIfReady(): Promise<void> {
    if (!this.authKey) await this.initKey()
    if (!this.localHello || !this.remoteHello || this.sentProof) return
    const payload = this.makeProofPayload(this.localHello, this.remoteHello, this.attempt)
    const mac = await this.signPayload(payload)
    this.sentProofMac = mac
    this.sentProof = true
    const proof: AuthProofMessage = { kind: 'AUTH_PROOF', attempt: this.attempt, from: this.selfId, nonce: this.localHello.nonce, peerNonce: this.remoteHello.nonce, ts: this.localHello.ts, peerTs: this.remoteHello.ts, mac }
    this.connectionSend(proof)
  }

  private maybeFinalize(): void {
    if (this.peerProofVerified && this.peerAckVerified) {
      this.cleanupAttemptTimer()
      this.state = 'authenticated'
      if (this.onAuthenticatedCb) this.onAuthenticatedCb()
    }
  }
}

export default AuthManager
