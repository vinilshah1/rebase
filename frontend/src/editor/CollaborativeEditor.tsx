import { useEffect, useRef } from 'react'
import { SyncClient, type Telemetry } from './syncClient'

interface Props { room: string; latency: number; onTelemetry: (value: Telemetry) => void }
export function CollaborativeEditor({ room, latency, onTelemetry }: Props) {
  const parent = useRef<HTMLDivElement>(null)
  const client = useRef<SyncClient | null>(null)
  const initial = useRef({ room, latency, onTelemetry })
  useEffect(() => {
    if (!parent.current) return
    const sync = new SyncClient(parent.current, initial.current.room, initial.current.latency, initial.current.onTelemetry)
    client.current = sync
    return () => { client.current = null; sync.destroy() }
  }, [])
  useEffect(() => { client.current?.setLatency(latency) }, [latency])
  return <div ref={parent} className="min-h-[60vh]" />
}
