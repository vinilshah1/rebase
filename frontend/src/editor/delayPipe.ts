/** A single timer services a FIFO queue, including equal delivery deadlines. */
export class DelayPipe<T> {
  private queue: { item: T; deliverAt: number }[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastDeliverAt = -Infinity
  private latencyMs = 0

  private readonly deliver: (item: T) => void

  constructor(deliver: (item: T) => void, latencyMs = 0) {
    this.deliver = deliver
    this.setLatency(latencyMs)
  }

  setLatency(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error('Invalid latency')
    this.latencyMs = latencyMs
  }

  push(item: T): void {
    const deliverAt = Math.max(performance.now() + this.latencyMs, this.lastDeliverAt)
    this.lastDeliverAt = deliverAt
    this.queue.push({ item, deliverAt })
    this.schedule()
  }

  /** Discard queued deliveries, e.g. after a fatal desync. */
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.queue = []
    this.lastDeliverAt = -Infinity
  }

  private schedule(): void {
    const head = this.queue[0]
    if (this.timer !== undefined || !head) return
    this.timer = setTimeout(() => {
      this.queue.shift()
      // Keep the timer marked active during callbacks so reentrant pushes cannot
      // create a second timer or skip the existing queue head.
      try { this.deliver(head.item) } finally {
        this.timer = undefined
        this.schedule()
      }
    }, Math.max(0, head.deliverAt - performance.now()))
  }
}
