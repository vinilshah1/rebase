import { afterEach, expect, it, vi } from 'vitest'
import { DelayPipe } from './delayPipe'
afterEach(() => vi.useRealTimers())
it.each([0, 100])('delivers FIFO at latency %s with equal deadlines', latency => {
  vi.useFakeTimers()
  const delivered: number[] = []
  const pipe = new DelayPipe<number>(x => delivered.push(x), latency)
  for (let i = 0; i < 5; i++) pipe.push(i)
  expect(vi.getTimerCount()).toBe(1)
  expect(delivered).toEqual([])
  vi.runAllTimers()
  expect(delivered).toEqual([0, 1, 2, 3, 4])
})
it('latency changes affect only future items and never permit overtaking', () => {
  vi.useFakeTimers()
  const delivered: number[] = []
  const pipe = new DelayPipe<number>(x => delivered.push(x), 100)
  pipe.push(1)
  vi.advanceTimersByTime(20)
  for (const latency of [0, 50, 1, 200, 0]) { pipe.setLatency(latency); pipe.push(latency) }
  vi.advanceTimersByTime(79)
  expect(delivered).toEqual([])
  vi.advanceTimersByTime(1)
  expect(delivered[0]).toBe(1)
  vi.runAllTimers()
  expect(delivered).toEqual([1, 0, 50, 1, 200, 0])
})
it('can cancel queued deliveries and accepts reentrant pushes', () => {
  vi.useFakeTimers()
  const delivered: number[] = []
  const pipe = new DelayPipe<number>(x => { delivered.push(x); if (x === 1) pipe.push(3) })
  pipe.push(9)
  pipe.clear()
  pipe.push(1)
  pipe.push(2)
  vi.runAllTimers()
  expect(delivered).toEqual([1, 2, 3])
})
