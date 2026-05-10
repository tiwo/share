<script setup lang="ts">
import Peer, { type DataConnection, type MediaConnection } from 'peerjs'
import QRCode from 'qrcode'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createGuestPeerId,
  createShareUrl,
  deriveAuthKey,
  deriveRoomPeerId,
  generateSecret,
  generateNonce,
  parseSecretFromLocation,
  secureEqual,
  signAuthPayload,
} from './lib/crypto'
import {
  attachStreamToVideo,
  buildBackoffSchedule,
  describeMediaError,
  detachStreamFromVideo,
  stopMediaStream,
  type ConnectionPhase,
} from './lib/helpers'

type SessionRole = 'host' | 'guest'
type AuthState = 'idle' | 'in-progress' | 'authenticated' | 'failed'

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

type AuthMessage = AuthHelloMessage | AuthProofMessage | AuthAckMessage | AuthFailMessage

const reconnectSchedule = buildBackoffSchedule(6)
const authRetrySchedule = [400, 850, 1600]
const maxAuthAttempts = 3
const replayWindowMs = 90_000
const nonceCacheTtlMs = 10 * 60_000
const authAttemptTimeoutMs = 9_000

const role = ref<SessionRole>('host')
const phase = ref<ConnectionPhase>('INIT')
const authState = ref<AuthState>('idle')
const authText = ref('Waiting for peer authentication.')
const lastAuthFailure = ref('')

const nonceCacheSize = computed(() => seenNonces.size)

const clearNonceCache = (): void => {
  seenNonces.clear()
}
const secret = ref('')
const roomPeerId = ref('')
const selfPeerId = ref('')
const remotePeerId = ref('')
const shareUrl = ref('')
const qrCodeUrl = ref('')
const statusText = ref('Bootstrapping session...')
const errorText = ref('')

const localVideo = ref<HTMLVideoElement | null>(null)
const remoteVideo = ref<HTMLVideoElement | null>(null)

const localStream = ref<MediaStream | null>(null)
const remoteStream = ref<MediaStream | null>(null)

let peer: Peer | null = null
let dataConnection: DataConnection | null = null
let activeCall: MediaConnection | null = null
let reconnectTimer: number | null = null
let authAttemptTimer: number | null = null
let reconnectAttempt = 0
let authAttempt = 0
let authKey: CryptoKey | null = null
let localHello: AuthHelloMessage | null = null
let remoteHello: AuthHelloMessage | null = null
let sentProofMac = ''
let sentProof = false
let peerProofVerified = false
let peerAckVerified = false
const seenNonces = new Map<string, number>()
let destroyed = false

const isConnected = computed(() => phase.value === 'CONNECTED')
const isAuthenticated = computed(() => authState.value === 'authenticated')
const hasLocalCamera = computed(() => localStream.value !== null)
const hasRemoteVideo = computed(() => remoteStream.value !== null)

const isHost = computed(() => role.value === 'host')

const phaseLabel = computed(() => {
  if (phase.value === 'CONNECTED') {
    return 'Connected'
  }
  if (phase.value === 'RECONNECTING') {
    return 'Reconnecting'
  }
  if (phase.value === 'FAILED') {
    return 'Connection failed'
  }
  if (phase.value === 'CLOSED') {
    return 'Closed'
  }
  if (phase.value === 'SIGNALING') {
    return 'Signaling'
  }
  return 'Initializing'
})

const clearError = (): void => {
  errorText.value = ''
}

const setError = (message: string): void => {
  errorText.value = message
}

const cleanupReconnectTimer = (): void => {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

const setStatus = (message: string): void => {
  statusText.value = message
}

const setAuthStatus = (state: AuthState, message: string): void => {
  authState.value = state
  authText.value = message
}

const targetPeerForCall = computed(() => {
  if (role.value === 'guest') {
    return roomPeerId.value
  }

  return remotePeerId.value
})

const closeActiveCall = (): void => {
  if (!activeCall) {
    return
  }

  activeCall.off('stream')
  activeCall.off('close')
  activeCall.off('error')
  activeCall.close()
  activeCall = null
}

const cleanupAuthAttemptTimer = (): void => {
  if (authAttemptTimer !== null) {
    window.clearTimeout(authAttemptTimer)
    authAttemptTimer = null
  }
}

const resetAuthAttemptState = (): void => {
  cleanupAuthAttemptTimer()
  localHello = null
  remoteHello = null
  sentProofMac = ''
  sentProof = false
  peerProofVerified = false
  peerAckVerified = false
}

const resetAuthSession = (): void => {
  authAttempt = 0
  resetAuthAttemptState()
  setAuthStatus('idle', 'Waiting for peer authentication.')
}

const pruneNonceCache = (): void => {
  const now = Date.now()
  for (const [nonce, expiresAt] of seenNonces.entries()) {
    if (expiresAt <= now) {
      seenNonces.delete(nonce)
    }
  }
}

const rememberNonce = (nonce: string): boolean => {
  pruneNonceCache()
  if (seenNonces.has(nonce)) {
    return false
  }

  seenNonces.set(nonce, Date.now() + nonceCacheTtlMs)
  return true
}

const isFreshTimestamp = (timestamp: number): boolean => {
  return Math.abs(Date.now() - timestamp) <= replayWindowMs
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const parseAuthMessage = (value: unknown): AuthMessage | null => {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null
  }

  if (value.kind === 'AUTH_HELLO') {
    if (
      typeof value.attempt === 'number' &&
      typeof value.from === 'string' &&
      typeof value.nonce === 'string' &&
      typeof value.ts === 'number'
    ) {
      return value as AuthHelloMessage
    }
    return null
  }

  if (value.kind === 'AUTH_PROOF') {
    if (
      typeof value.attempt === 'number' &&
      typeof value.from === 'string' &&
      typeof value.nonce === 'string' &&
      typeof value.peerNonce === 'string' &&
      typeof value.ts === 'number' &&
      typeof value.peerTs === 'number' &&
      typeof value.mac === 'string'
    ) {
      return value as AuthProofMessage
    }
    return null
  }

  if (value.kind === 'AUTH_ACK') {
    if (
      typeof value.attempt === 'number' &&
      typeof value.from === 'string' &&
      typeof value.proofMac === 'string' &&
      typeof value.mac === 'string'
    ) {
      return value as AuthAckMessage
    }
    return null
  }

  if (value.kind === 'AUTH_FAIL') {
    if (
      typeof value.attempt === 'number' &&
      typeof value.from === 'string' &&
      typeof value.reason === 'string'
    ) {
      return value as AuthFailMessage
    }
  }

  return null
}

const makeProofPayload = (sender: AuthHelloMessage, receiver: AuthHelloMessage, attempt: number): string => {
  return [
    'proof',
    attempt,
    sender.from,
    receiver.from,
    sender.nonce,
    receiver.nonce,
    sender.ts,
    receiver.ts,
  ].join('|')
}

const makeAckPayload = (
  senderPeerId: string,
  receiverPeerId: string,
  attempt: number,
  proofMac: string,
): string => {
  return ['ack', attempt, senderPeerId, receiverPeerId, proofMac].join('|')
}

const finalizeAuthentication = (): void => {
  if (!peerProofVerified || !peerAckVerified) {
    return
  }

  cleanupAuthAttemptTimer()
  setAuthStatus('authenticated', 'Authenticated. Camera controls unlocked.')
  setStatus('Peer authenticated. Camera sharing is ready.')
  clearError()

  if (hasLocalCamera.value) {
    startOutgoingCall()
  }
}

const startAuthAttempt = async (connection: DataConnection): Promise<void> => {
  if (!connection.open) {
    return
  }

  if (!authKey) {
    authKey = await deriveAuthKey(secret.value)
  }

  if (authAttempt >= maxAuthAttempts) {
    setAuthStatus('failed', 'Authentication failed after 3 attempts.')
    setError('Authentication failed after 3 attempts. Use Reconnect to try again.')
    return
  }

  authAttempt += 1
  resetAuthAttemptState()
  setAuthStatus('in-progress', `Authenticating peer (attempt ${authAttempt}/${maxAuthAttempts})...`)
  setStatus('Peer connected. Authentication in progress...')

  localHello = {
    kind: 'AUTH_HELLO',
    attempt: authAttempt,
    from: selfPeerId.value,
    nonce: generateNonce(12),
    ts: Date.now(),
  }
  connection.send(localHello)

  authAttemptTimer = window.setTimeout(() => {
    void failAuthentication(connection, 'Authentication timed out.')
  }, authAttemptTimeoutMs)
}

const sendProofIfReady = async (connection: DataConnection): Promise<void> => {
  if (!authKey || !localHello || !remoteHello || sentProof) {
    return
  }

  const proofPayload = makeProofPayload(localHello, remoteHello, authAttempt)
  const mac = await signAuthPayload(authKey, proofPayload)
  sentProofMac = mac
  sentProof = true

  const proof: AuthProofMessage = {
    kind: 'AUTH_PROOF',
    attempt: authAttempt,
    from: selfPeerId.value,
    nonce: localHello.nonce,
    peerNonce: remoteHello.nonce,
    ts: localHello.ts,
    peerTs: remoteHello.ts,
    mac,
  }
  connection.send(proof)
}

const failAuthentication = async (connection: DataConnection, reason: string): Promise<void> => {
  cleanupAuthAttemptTimer()
  setAuthStatus('in-progress', `${reason} Retrying...`)
  lastAuthFailure.value = reason

  const failMessage: AuthFailMessage = {
    kind: 'AUTH_FAIL',
    attempt: authAttempt,
    from: selfPeerId.value,
    reason,
  }
  if (connection.open) {
    connection.send(failMessage)
  }

  if (authAttempt >= maxAuthAttempts) {
    setAuthStatus('failed', 'Authentication failed after 3 attempts.')
    setError('Authentication failed after 3 attempts. Use Reconnect to retry.')
    return
  }

  const delay = authRetrySchedule[Math.max(0, authAttempt - 1)] ?? 400
  window.setTimeout(() => {
    if (!connection.open || dataConnection !== connection || destroyed) {
      return
    }
    void startAuthAttempt(connection)
  }, delay)
}

const processAuthMessage = async (connection: DataConnection, message: AuthMessage): Promise<void> => {
  if (authState.value === 'authenticated') {
    return
  }

  if (message.kind === 'AUTH_FAIL') {
    setAuthStatus('in-progress', `Peer reported auth issue: ${message.reason}`)
    return
  }

  if (message.attempt < authAttempt) {
    return
  }

  if (message.attempt > authAttempt) {
    authAttempt = message.attempt - 1
    await startAuthAttempt(connection)
  }

  if (message.kind === 'AUTH_HELLO') {
    if (!isFreshTimestamp(message.ts)) {
      await failAuthentication(connection, 'Auth challenge timestamp is outside the replay window.')
      return
    }

    if (!rememberNonce(message.nonce)) {
      await failAuthentication(connection, 'Replay detected in auth challenge.')
      return
    }

    remoteHello = message
    await sendProofIfReady(connection)
    return
  }

  if (!authKey || !localHello || !remoteHello) {
    await failAuthentication(connection, 'Auth state is incomplete for verification.')
    return
  }

  if (message.kind === 'AUTH_PROOF') {
    if (message.from !== remoteHello.from || message.from !== connection.peer) {
      await failAuthentication(connection, 'Auth proof sender does not match connection peer.')
      return
    }

    if (
      message.nonce !== remoteHello.nonce ||
      message.peerNonce !== localHello.nonce ||
      message.ts !== remoteHello.ts ||
      message.peerTs !== localHello.ts
    ) {
      await failAuthentication(connection, 'Auth proof payload mismatch.')
      return
    }

    const expectedMac = await signAuthPayload(authKey, makeProofPayload(remoteHello, localHello, authAttempt))
    if (!secureEqual(message.mac, expectedMac)) {
      await failAuthentication(connection, 'Auth proof MAC verification failed.')
      return
    }

    peerProofVerified = true
    const ackPayload = makeAckPayload(selfPeerId.value, remoteHello.from, authAttempt, message.mac)
    const ackMac = await signAuthPayload(authKey, ackPayload)
    const ackMessage: AuthAckMessage = {
      kind: 'AUTH_ACK',
      attempt: authAttempt,
      from: selfPeerId.value,
      proofMac: message.mac,
      mac: ackMac,
    }
    connection.send(ackMessage)
    finalizeAuthentication()
    return
  }

  if (message.kind === 'AUTH_ACK') {
    if (message.from !== remoteHello.from || message.from !== connection.peer) {
      await failAuthentication(connection, 'Auth ACK sender does not match connection peer.')
      return
    }

    if (!sentProofMac || message.proofMac !== sentProofMac) {
      await failAuthentication(connection, 'Auth ACK does not match active proof.')
      return
    }

    const expectedAck = await signAuthPayload(
      authKey,
      makeAckPayload(remoteHello.from, selfPeerId.value, authAttempt, sentProofMac),
    )
    if (!secureEqual(message.mac, expectedAck)) {
      await failAuthentication(connection, 'Auth ACK MAC verification failed.')
      return
    }

    peerAckVerified = true
    finalizeAuthentication()
  }
}

const handleRemoteStreamEnded = async (): Promise<void> => {
  remoteStream.value = null
  detachStreamFromVideo(remoteVideo.value)
}

const bindMediaCall = (call: MediaConnection): void => {
  if (activeCall && activeCall !== call) {
    closeActiveCall()
  }

  activeCall = call

  call.on('stream', async (stream) => {
    remoteStream.value = stream
    await attachStreamToVideo(remoteVideo.value, stream)
    setStatus('Live video stream active.')
  })

  call.on('close', () => {
    if (activeCall === call) {
      activeCall = null
    }
    void handleRemoteStreamEnded()
  })

  call.on('error', (error) => {
    if (activeCall === call) {
      activeCall = null
    }
    void handleRemoteStreamEnded()
    setError(`Media call error: ${error.message}`)
  })
}

const startOutgoingCall = (): void => {
  if (!peer || !localStream.value || !isConnected.value || !isAuthenticated.value) {
    return
  }

  const targetPeerId = targetPeerForCall.value
  if (!targetPeerId || targetPeerId === selfPeerId.value) {
    return
  }

  const call = peer.call(targetPeerId, localStream.value)
  bindMediaCall(call)
}

const setupDataConnection = (connection: DataConnection): void => {
  if (
    dataConnection &&
    dataConnection !== connection &&
    dataConnection.open &&
    dataConnection.peer !== connection.peer
  ) {
    connection.close()
    return
  }

  dataConnection = connection
  remotePeerId.value = connection.peer

  connection.on('open', () => {
    reconnectAttempt = 0
    phase.value = 'CONNECTED'
    setStatus('Peer connection ready. Starting authentication...')
    setAuthStatus('in-progress', 'Authenticating peer...')
    clearError()
    void startAuthAttempt(connection)
  })

  connection.on('data', (payload) => {
    const authMessage = parseAuthMessage(payload)
    if (!authMessage) {
      return
    }

    void processAuthMessage(connection, authMessage)
  })

  connection.on('close', () => {
    if (dataConnection === connection) {
      dataConnection = null
    }
    resetAuthSession()
    phase.value = 'RECONNECTING'
    setStatus('Peer connection lost. Trying to reconnect...')
    scheduleReconnect()
  })

  connection.on('error', (error) => {
    setError(`Data connection error: ${error.message}`)
  })
}

const tryGuestConnect = (): void => {
  if (!peer || !peer.open || role.value !== 'guest') {
    return
  }

  if (dataConnection?.open) {
    return
  }

  const connection = peer.connect(roomPeerId.value, {
    reliable: true,
    metadata: { app: 'share', role: 'guest' },
  })
  setupDataConnection(connection)
}

const scheduleReconnect = (): void => {
  cleanupReconnectTimer()

  if (destroyed) {
    return
  }

  if (reconnectAttempt >= reconnectSchedule.length) {
    phase.value = 'FAILED'
    setStatus('Reconnect attempts exhausted. Use Reconnect to try again.')
    return
  }

  const delay = reconnectSchedule[reconnectAttempt]
  reconnectAttempt += 1
  reconnectTimer = window.setTimeout(() => {
    if (destroyed) {
      return
    }

    phase.value = 'RECONNECTING'

    if (peer?.disconnected) {
      peer.reconnect()
    }

    if (role.value === 'guest') {
      tryGuestConnect()
    }

    if (hasLocalCamera.value) {
      startOutgoingCall()
    }
  }, delay)
}

const startCamera = async (): Promise<void> => {
  clearError()

  if (!isAuthenticated.value) {
    setError('Wait for peer authentication before starting camera sharing.')
    return
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    })
    localStream.value = stream
    await attachStreamToVideo(localVideo.value, stream, true)
    setStatus('Camera enabled.')

    if (isConnected.value) {
      startOutgoingCall()
    }
  } catch (error) {
    setError(describeMediaError(error))
  }
}

const stopCamera = (): void => {
  stopMediaStream(localStream.value)
  localStream.value = null
  detachStreamFromVideo(localVideo.value)
  closeActiveCall()
  if (!hasRemoteVideo.value) {
    setStatus('Camera stopped.')
  }
}

const copyShareLink = async (): Promise<void> => {
  if (!shareUrl.value) {
    return
  }

  try {
    await navigator.clipboard.writeText(shareUrl.value)
    setStatus('Invite link copied to clipboard.')
  } catch {
    setError('Clipboard permission is unavailable in this browser context.')
  }
}

const reconnectNow = (): void => {
  clearError()
  resetAuthSession()
  reconnectAttempt = 0
  cleanupReconnectTimer()

  if (peer?.disconnected) {
    peer.reconnect()
  }

  if (role.value === 'guest') {
    tryGuestConnect()
  }

  if (hasLocalCamera.value) {
    startOutgoingCall()
  }
}

const destroyPeer = (): void => {
  cleanupReconnectTimer()
  resetAuthSession()
  closeActiveCall()
  if (dataConnection) {
    dataConnection.close()
    dataConnection = null
  }
  if (peer && !peer.destroyed) {
    peer.destroy()
  }
  peer = null
  authKey = null
}

const bootstrap = async (): Promise<void> => {
  try {
    const parsedSecret = parseSecretFromLocation()
    if (parsedSecret) {
      role.value = 'guest'
      secret.value = parsedSecret
    } else {
      role.value = 'host'
      secret.value = generateSecret()
      window.history.replaceState(null, '', `#${secret.value}`)
    }

    shareUrl.value = createShareUrl(secret.value)
    roomPeerId.value = await deriveRoomPeerId(secret.value)
    selfPeerId.value = role.value === 'host' ? roomPeerId.value : createGuestPeerId()
    phase.value = 'SIGNALING'
    setStatus('Opening signaling channel...')

    peer = new Peer(selfPeerId.value)
    authKey = await deriveAuthKey(secret.value)

    peer.on('open', () => {
      phase.value = 'SIGNALING'
      if (role.value === 'host') {
        setStatus('Host ready. Share the link and wait for a guest.')
      } else {
        setStatus('Guest signaling ready. Connecting to host...')
        tryGuestConnect()
      }
    })

    peer.on('connection', (incomingConnection) => {
      if (role.value !== 'host') {
        incomingConnection.close()
        return
      }

      if (dataConnection?.open && dataConnection.peer !== incomingConnection.peer) {
        incomingConnection.close()
        return
      }

      setupDataConnection(incomingConnection)
    })

    peer.on('call', (incomingCall) => {
      bindMediaCall(incomingCall)
      incomingCall.answer(localStream.value ?? undefined)
    })

    peer.on('disconnected', () => {
      phase.value = 'RECONNECTING'
      setStatus('Signaling disconnected. Attempting reconnect...')
      scheduleReconnect()
    })

    peer.on('close', () => {
      phase.value = 'CLOSED'
      setStatus('Peer session closed.')
    })

    peer.on('error', (error) => {
      setError(`Peer error: ${error.message}`)
      if (phase.value !== 'CONNECTED') {
        phase.value = 'FAILED'
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected startup error.'
    setError(message)
    phase.value = 'FAILED'
  }
}

watch(
  shareUrl,
  async (value) => {
    if (!value) {
      qrCodeUrl.value = ''
      return
    }

    try {
      qrCodeUrl.value = await QRCode.toDataURL(value, {
        margin: 1,
        width: 224,
        errorCorrectionLevel: 'M',
      })
    } catch {
      qrCodeUrl.value = ''
    }
  },
  { immediate: true },
)

watch(localStream, async (stream) => {
  await nextTick()
  if (stream) {
    await attachStreamToVideo(localVideo.value, stream, true)
  } else {
    detachStreamFromVideo(localVideo.value)
  }
})

watch(isAuthenticated, (authenticated) => {
  if (!authenticated) {
    closeActiveCall()
    void handleRemoteStreamEnded()
  }
})

watch(remoteStream, async (stream) => {
  await nextTick()
  if (stream) {
    await attachStreamToVideo(remoteVideo.value, stream)
  } else {
    detachStreamFromVideo(remoteVideo.value)
  }
})

onMounted(() => {
  void bootstrap()
})

onBeforeUnmount(() => {
  destroyed = true
  cleanupAuthAttemptTimer()
  stopMediaStream(localStream.value)
  stopMediaStream(remoteStream.value)
  localStream.value = null
  remoteStream.value = null
  destroyPeer()
})
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">tiwo.github.io/share</p>
        <h1>Camera-First Peer Session</h1>
      </div>
      <span class="badge" :data-state="phase">{{ phaseLabel }}</span>
    </header>

    <section class="session-grid">
      <article class="panel session-panel">
        <h2>Session</h2>
        <p class="meta-row">
          <strong>Role:</strong>
          <span>{{ isHost ? 'Host' : 'Guest' }}</span>
        </p>
        <p class="meta-row">
          <strong>Peer ID:</strong>
          <span class="code-like">{{ selfPeerId || 'pending' }}</span>
        </p>
        <p class="meta-row">
          <strong>Status:</strong>
          <span>{{ statusText }}</span>
        </p>
        <p class="meta-row">
          <strong>Auth:</strong>
          <span>{{ authText }}</span>
        </p>
        <details class="auth-diagnostics">
          <summary>Auth diagnostics</summary>
          <div class="diag-row"><strong>State:</strong> <span>{{ authState }}</span></div>
          <div class="diag-row"><strong>Attempts:</strong> <span>{{ authAttempt }}</span></div>
          <div class="diag-row"><strong>Last failure:</strong> <span class="code-like">{{ lastAuthFailure || 'none' }}</span></div>
          <div class="diag-row"><strong>Nonce cache:</strong> <span>{{ nonceCacheSize }}</span></div>
          <div class="diag-row"><strong>Replay window:</strong> <span>{{ Math.round(replayWindowMs/1000) }}s</span></div>
          <div style="margin-top:8px"><button class="button ghost" @click="clearNonceCache">Clear nonce cache</button></div>
        </details>
        <p class="meta-row">
          <strong>Auth:</strong>
          <span>{{ authText }}</span>
        </p>

        <div class="link-wrap">
          <label for="share-link">Invite link</label>
          <input id="share-link" :value="shareUrl" readonly />
          <button type="button" class="button" @click="copyShareLink">
            Copy invite link
          </button>
        </div>

        <div class="qr-wrap" v-if="qrCodeUrl">
          <img :src="qrCodeUrl" alt="Session QR code" />
        </div>
      </article>

      <article class="panel controls-panel">
        <h2>Controls</h2>
        <div class="button-row">
          <button
            type="button"
            class="button"
            :disabled="hasLocalCamera || !isAuthenticated"
            @click="startCamera"
          >
            Start camera
          </button>
          <button type="button" class="button ghost" :disabled="!hasLocalCamera" @click="stopCamera">
            Stop camera
          </button>
          <button type="button" class="button ghost" @click="reconnectNow">Reconnect</button>
        </div>

        <p v-if="errorText" class="error-text">{{ errorText }}</p>
        <p v-else-if="!isAuthenticated" class="hint-text">
          Camera controls unlock after authentication succeeds.
        </p>
        <p v-else class="hint-text">
          Camera is video-only in this phase. Microphone, chat, and file sharing come next.
        </p>
      </article>
    </section>

    <section class="video-grid">
      <article class="panel video-panel">
        <h2>Your Camera</h2>
        <video ref="localVideo" muted playsinline autoplay></video>
        <p class="panel-foot">{{ hasLocalCamera ? 'Live preview' : 'Camera not active' }}</p>
      </article>

      <article class="panel video-panel">
        <h2>Remote Camera</h2>
        <video ref="remoteVideo" playsinline autoplay></video>
        <p class="panel-foot">{{ hasRemoteVideo ? 'Receiving stream' : 'Waiting for remote camera' }}</p>
      </article>
    </section>
  </main>
</template>
