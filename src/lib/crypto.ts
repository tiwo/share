const SECRET_BYTES = 18

const baseUrlSafe = (value: string): string =>
	value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

const fromBaseUrlSafe = (value: string): string => {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const padding = (4 - (base64.length % 4)) % 4
	return `${base64}${'='.repeat(padding)}`
}

const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')

export const normalizeFragment = (fragment: string): string => {
	const trimmed = fragment.trim()
	return trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
}

export const decodeSecret = (raw: string): Uint8Array | null => {
	try {
		const normalized = normalizeFragment(raw)
		if (!normalized) {
			return null
		}

		const binary = atob(fromBaseUrlSafe(normalized))
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
		if (bytes.byteLength !== SECRET_BYTES) {
			return null
		}

		return bytes
	} catch {
		return null
	}
}

export const encodeSecret = (bytes: Uint8Array): string => {
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
	return baseUrlSafe(btoa(binary))
}

export const generateSecret = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
	return encodeSecret(bytes)
}

export const parseSecretFromLocation = (): string | null => {
	const fragment = normalizeFragment(window.location.hash)
	if (!fragment) {
		return null
	}

	return decodeSecret(fragment) ? fragment : null
}

export const deriveRoomPeerId = async (secret: string): Promise<string> => {
	const keyBytes = decodeSecret(secret)
	if (!keyBytes) {
		throw new Error('Invalid session secret in URL fragment.')
	}

	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
	const hash = toHex(new Uint8Array(digest))
	return `share-room-${hash.slice(0, 32)}`
}

export const createGuestPeerId = (): string => {
	const random = crypto.getRandomValues(new Uint8Array(8))
	return `share-guest-${toHex(random)}`
}

export const generateNonce = (byteLength = 16): string => {
	const nonce = crypto.getRandomValues(new Uint8Array(byteLength))
	return encodeSecret(nonce)
}

export const deriveAuthKey = async (secret: string): Promise<CryptoKey> => {
	const keyBytes = decodeSecret(secret)
	if (!keyBytes) {
		throw new Error('Cannot derive auth key from invalid secret.')
	}

	const keyMaterial = new TextEncoder().encode(secret)

	return crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	])
}

const bytesToBase64Url = (bytes: Uint8Array): string => {
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
	return baseUrlSafe(btoa(binary))
}

export const base64UrlToBytes = (value: string): Uint8Array => {
	const base64 = fromBaseUrlSafe(value)
	const binary = atob(base64)
	return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export { bytesToBase64Url }

export const signAuthPayload = async (key: CryptoKey, payload: string): Promise<string> => {
	const data = new TextEncoder().encode(payload)
	const signature = await crypto.subtle.sign('HMAC', key, data)
	return bytesToBase64Url(new Uint8Array(signature))
}

export const secureEqual = (left: string, right: string): boolean => {
	if (left.length !== right.length) {
		return false
	}

	let mismatch = 0
	for (let index = 0; index < left.length; index += 1) {
		mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
	}

	return mismatch === 0
}

export const createShareUrl = (secret: string): string => {
	const url = new URL(window.location.href)
	url.hash = secret
	return url.toString()
}
