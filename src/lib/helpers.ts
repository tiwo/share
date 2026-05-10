export const CONNECTION_PHASES = [
	'INIT',
	'SIGNALING',
	'CONNECTED',
	'RECONNECTING',
	'FAILED',
	'CLOSED',
] as const

export type ConnectionPhase = (typeof CONNECTION_PHASES)[number]

const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')

export const buildBackoffSchedule = (
	attempts: number,
	baseDelayMs = 500,
	maxDelayMs = 8_000,
): number[] => {
	return Array.from({ length: attempts }, (_, index) => {
		const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** index)
		const jitter = Math.floor(Math.random() * 300)
		return exponential + jitter
	})
}

export const attachStreamToVideo = async (
	element: HTMLVideoElement | null,
	stream: MediaStream,
	muted = false,
): Promise<void> => {
	if (!element) {
		return
	}

	element.srcObject = stream
	element.muted = muted
	element.playsInline = true
	element.autoplay = true

	try {
		await element.play()
	} catch {
		// Ignore autoplay race conditions while keeping stream attached.
	}
}

export const detachStreamFromVideo = (element: HTMLVideoElement | null): void => {
	if (!element) {
		return
	}

	element.pause()
	element.srcObject = null
}

export const stopMediaStream = (stream: MediaStream | null): void => {
	if (!stream) {
		return
	}

	stream.getTracks().forEach((track) => {
		track.stop()
	})
}

export const describeMediaError = (error: unknown): string => {
	if (error instanceof DOMException) {
		if (error.name === 'NotAllowedError') {
			return 'Camera permission was denied.'
		}

		if (error.name === 'NotFoundError') {
			return 'No camera was found on this device.'
		}

		if (error.name === 'NotReadableError') {
			return 'Camera is busy in another application.'
		}

		return `${error.name}: ${error.message}`
	}

	if (error instanceof Error) {
		return error.message
	}

	return 'An unknown camera error occurred.'
}

export type ChatMessage = {
	kind: 'CHAT_MSG'
	id: string
	from: string
	ts: number
	text: string
	meta?: Record<string, unknown>
}

export const createChatId = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	return `m-${toHex(bytes)}`
}

export const parseChatMessage = (value: unknown): ChatMessage | null => {
	if (typeof value !== 'object' || value === null) return null
	const v = value as Record<string, unknown>
	if (v.kind !== 'CHAT_MSG') return null
	if (typeof v.id !== 'string') return null
	if (typeof v.from !== 'string') return null
	if (typeof v.ts !== 'number') return null
	if (typeof v.text !== 'string') return null
	const chat: ChatMessage = { kind: 'CHAT_MSG', id: v.id, from: v.from, ts: v.ts, text: v.text }
	if (v.meta && typeof v.meta === 'object') chat.meta = v.meta as Record<string, unknown>
	return chat
}
