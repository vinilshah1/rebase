import { useState } from 'react'
import { CollaborativeEditor } from './editor/CollaborativeEditor'
import { initialTelemetry, roomFromSearch } from './editor/syncClient'

function App() {
  const [room] = useState(() => roomFromSearch(location.search))
  const [latency, setLatency] = useState(0)
  const [telemetry, setTelemetry] = useState(initialTelemetry)
  const fatal = telemetry.status === 'DESYNCED' || telemetry.status === 'DISCONNECTED'
  const pending = telemetry.pendingOps.length
  const status = telemetry.status === 'DESYNCED' ? 'Desynced: reload the tab'
    : telemetry.status === 'DISCONNECTED' ? 'Disconnected: reload the tab'
    : telemetry.status === 'CONNECTED' ? pending ? `Reconciling (${pending} pending ops)...` : 'Synced'
    : telemetry.status === 'INITIALIZING' ? 'Waiting for snapshot…' : 'Connecting…'
  return (
    <main className="min-h-screen bg-[#FAF9F6] text-[#141413]">
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-[#E5E5E0] px-5 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="font-medium">PoC // Server Reconciliation Engine</h1>
          <span role="status" className={fatal ? 'text-red-700' : pending ? 'text-[#D96B43]' : 'text-[#3D8C65]'}>{status}</span>
          {telemetry.invariantBroken && <span role="alert" className="rounded bg-red-700 px-2 py-1 font-bold text-white">INVARIANT BROKEN</span>}
        </div>
        <div className="flex flex-wrap items-center gap-5 font-mono text-[11px]">
          <label className="flex items-center gap-2">Latency
            <span>0ms</span><input aria-label="Network latency" type="range" min="0" max="2000" step="10" value={latency} onChange={event => setLatency(Number(event.target.value))} className="w-28 accent-[#3D8C65]" /><span>2000ms</span>
            <output className="w-14 text-right">{latency}ms</output>
          </label>
          <span>{telemetry.characters} chars</span>
          <span>idList.length {telemetry.idListLength}</span>
          <span>seq {telemetry.lastSeq}</span>
        </div>
      </header>
      <section className="mx-auto max-w-[68ch] px-6 pb-16 pt-12">
        <p className="mb-4 font-mono text-xs text-stone-500">Room / {room}</p>
        <CollaborativeEditor room={room} latency={latency} onTelemetry={setTelemetry} />
        <details className="mt-10 border-t border-[#E5E5E0] pt-4 text-xs text-stone-600">
          <summary className="cursor-pointer font-mono">pendingOps / {pending}</summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(telemetry.pendingOps, null, 2)}</pre>
        </details>
      </section>
    </main>
  )
}
export default App
