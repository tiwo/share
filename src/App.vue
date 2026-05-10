<script setup lang="ts">
import Peer, { type DataConnection, type MediaConnection } from 'peerjs'
import QRCode from 'qrcode'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  createGuestPeerId,
  createShareUrl,
  deriveRoomPeerId,
  generateSecret,
  parseSecretFromLocation,
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

const reconnectSchedule = buildBackoffSchedule(6)

const role = ref<SessionRole>('host')
const phase = ref<ConnectionPhase>('INIT')
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
let reconnectAttempt = 0
let destroyed = false

const isConnected = computed(() => phase.value === 'CONNECTED')
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
  if (!peer || !localStream.value || !isConnected.value) {
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
    setStatus('Peer connection ready. Camera sharing is available.')
    clearError()

    if (hasLocalCamera.value) {
      startOutgoingCall()
    }
  })

  connection.on('close', () => {
    if (dataConnection === connection) {
      dataConnection = null
    }
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
  closeActiveCall()
  if (dataConnection) {
    dataConnection.close()
    dataConnection = null
  }
  if (peer && !peer.destroyed) {
    peer.destroy()
  }
  peer = null
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
          <button type="button" class="button" :disabled="hasLocalCamera" @click="startCamera">
            Start camera
          </button>
          <button type="button" class="button ghost" :disabled="!hasLocalCamera" @click="stopCamera">
            Stop camera
          </button>
          <button type="button" class="button ghost" @click="reconnectNow">Reconnect</button>
        </div>

        <p v-if="errorText" class="error-text">{{ errorText }}</p>
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
