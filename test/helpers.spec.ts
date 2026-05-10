import { describe, it, expect, vi } from 'vitest'
import {
  buildBackoffSchedule,
  attachStreamToVideo,
  detachStreamFromVideo,
  stopMediaStream,
  describeMediaError,
} from '../src/lib/helpers'

describe('helpers', () => {
  it('builds backoff schedule of correct length and bounds', () => {
    const schedule = buildBackoffSchedule(5, 500, 2000)
    expect(schedule.length).toBe(5)
    for (const v of schedule) {
      expect(v).toBeGreaterThanOrEqual(500)
      expect(v).toBeLessThanOrEqual(2000 + 300)
    }
  })

  it('attaches and detaches stream to mock video element', async () => {
    const mockStream = { id: 's' }
    const play = vi.fn(() => Promise.resolve())
    const pause = vi.fn()
    const el: any = {
      srcObject: null,
      muted: false,
      playsInline: false,
      autoplay: false,
      play,
      pause,
    }

    await attachStreamToVideo(el, mockStream as any, true)
    expect(el.srcObject).toBe(mockStream)
    expect(el.muted).toBe(true)
    expect(play).toHaveBeenCalled()

    detachStreamFromVideo(el)
    expect(el.srcObject).toBe(null)
  })

  it('stops media stream tracks', () => {
    const stop1 = vi.fn()
    const stop2 = vi.fn()
    const stream: any = { getTracks: () => [{ stop: stop1 }, { stop: stop2 }] }
    stopMediaStream(stream)
    expect(stop1).toHaveBeenCalled()
    expect(stop2).toHaveBeenCalled()
  })

  it('describes errors', () => {
    const err = new Error('boom')
    expect(describeMediaError(err)).toBe('boom')
    expect(describeMediaError('x' as any)).toBe('An unknown camera error occurred.')
  })
})
