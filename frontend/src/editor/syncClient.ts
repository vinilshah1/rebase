import { Annotation, Compartment, EditorState } from '@codemirror/state'
import { defaultKeymap } from '@codemirror/commands'
import { drawSelection, EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { ElementIdGenerator } from 'articulated'
import { DelayPipe } from './delayPipe'
import { createState, initialize, onLocalChange, onServerOp, type ClientOp, type InitSnapshot, type LocalChange, type ServerOp } from './reconcile'

export const remoteSyncAnnotation = Annotation.define<boolean>()
export type ConnectionStatus = 'CONNECTING' | 'INITIALIZING' | 'CONNECTED' | 'DISCONNECTED' | 'DESYNCED'
export interface Telemetry {
  status: ConnectionStatus
  pendingOps: readonly ClientOp[]
  lastSeq: number
  characters: number
  idListLength: number
  invariantBroken: boolean
}
export const initialTelemetry: Telemetry = {
  status: 'CONNECTING', pendingOps: [], lastSeq: 0, characters: 0, idListLength: 0, invariantBroken: false,
}
type WireOp = Omit<ServerOp, 'clientId'> & { senderId: string }

export function roomFromSearch(search: string): string {
  return new URLSearchParams(search).get('room') || 'poc'
}

/** Owns one view/socket and delegates document transitions to the pure engine. */
export class SyncClient {
  readonly view: EditorView
  private readonly socket: WebSocket
  private state = createState()
  private status: ConnectionStatus = 'CONNECTING'
  private disposed = false
  private invariantBroken = false
  private readonly access = new Compartment()
  private readonly incoming: DelayPipe<InitSnapshot | ServerOp>
  private readonly outgoing: DelayPipe<ClientOp>
  private readonly allocator

  constructor(parent: HTMLElement, room: string, latency: number, privateTelemetry: (value: Telemetry) => void) {
    this.publishTelemetry = privateTelemetry
    const clientId = crypto.randomUUID()
    const generator = new ElementIdGenerator(() => crypto.randomUUID())
    this.allocator = {
      clientId, opId: () => crypto.randomUUID(),
      generateAfter: generator.generateAfter.bind(generator),
    }
    this.view = new EditorView({ parent, state: EditorState.create({ extensions: [
      EditorView.lineWrapping, drawSelection(), keymap.of(defaultKeymap),
      EditorView.contentAttributes.of({ 'aria-label': 'Collaborative plain-text document', class: 'min-h-[60vh] px-0 py-6 font-serif text-lg leading-8 outline-none' }),
      EditorView.editorAttributes.of({ class: 'bg-transparent text-[#141413]' }),
      this.access.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      // Also reject programmatic local document changes while synchronization is stopped.
      EditorState.transactionFilter.of(tr => tr.docChanged && !tr.annotation(remoteSyncAnnotation) && !this.active() ? [] : tr),
      EditorView.updateListener.of(update => this.localUpdate(update)),
    ] }) })
    this.outgoing = new DelayPipe(op => {
      if (!this.active() || this.socket.readyState !== WebSocket.OPEN) return
      const { clientId: senderId, ...fields } = op
      try { this.socket.send(JSON.stringify({ ...fields, senderId })) }
      catch { this.stop('DISCONNECTED') }
    }, latency)
    this.incoming = new DelayPipe(message => this.receive(message), latency)
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.socket = new WebSocket(`${protocol}//${location.host}/ws/doc/${encodeURIComponent(room)}/`)
    this.socket.addEventListener('open', this.open)
    this.socket.addEventListener('message', this.message)
    this.socket.addEventListener('close', this.closed)
    this.socket.addEventListener('error', this.closed)
    this.publish()
  }

  private readonly publishTelemetry: (value: Telemetry) => void
  private active(): boolean {
    return !this.disposed && this.status === 'CONNECTED' && this.state.status === 'READY'
  }
  private publish(): void {
    if (this.disposed) return
    this.publishTelemetry({ status: this.status, pendingOps: this.state.pendingOps, lastSeq: this.state.lastSeq,
      characters: this.view.state.doc.length, idListLength: this.state.localIdList.length, invariantBroken: this.invariantBroken })
  }
  private configureAccess(): void {
    const enabled = this.active()
    this.view.dispatch({ effects: this.access.reconfigure([EditorState.readOnly.of(!enabled), EditorView.editable.of(enabled)]) })
  }
  private assertDocument(): void {
    if (this.state.localIdList.length !== this.view.state.doc.length || this.state.text !== this.view.state.doc.toString()) {
      this.invariantBroken = true
      this.stop('DESYNCED')
    }
  }
  private localUpdate(update: ViewUpdate): void {
    if (!update.docChanged || update.transactions.some(tr => tr.annotation(remoteSyncAnnotation)) || !this.active()) return
    try {
      const changes: LocalChange[] = []
      update.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
        changes.push({ from: fromB, deleteCount: toA - fromA, insert: inserted.toString() })
      })
      const result = onLocalChange(this.state, changes, this.allocator)
      this.state = result.state
      for (const op of result.ops) this.outgoing.push(op)
      // No dispatch from an update listener, including on invariant failure.
      if (this.state.localIdList.length !== update.state.doc.length || this.state.text !== update.state.doc.toString()) {
        this.invariantBroken = true
        this.deferFatal()
      }
      this.publish()
    } catch { this.deferFatal() }
  }
  private deferFatal(): void {
    this.status = 'DESYNCED'
    this.incoming.clear()
    this.outgoing.clear()
    queueMicrotask(() => { if (!this.disposed) this.stop('DESYNCED') })
  }
  private readonly open = () => {
    if (this.disposed || this.status !== 'CONNECTING') return
    this.status = 'INITIALIZING'
    this.publish()
  }
  private readonly message = (event: MessageEvent<string>) => {
    if (this.disposed || this.status === 'DISCONNECTED' || this.status === 'DESYNCED') return
    try {
      const message = JSON.parse(event.data) as InitSnapshot | WireOp
      if (message.type === 'init') this.incoming.push(message)
      else if (message.type === 'insert' || message.type === 'delete') {
        const { senderId, ...op } = message
        this.incoming.push({ ...op, clientId: senderId } as ServerOp)
      } else this.stop('DESYNCED')
    } catch { this.stop('DESYNCED') }
  }
  private receive(message: InitSnapshot | ServerOp): void {
    if (this.disposed || this.status === 'DISCONNECTED' || this.status === 'DESYNCED') return
    try {
      if (message.type === 'init') {
        if (this.state.status !== 'UNINITIALIZED') { this.stop('DESYNCED'); return }
        this.state = initialize(this.state, message)
        this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: this.state.text }, selection: { anchor: 0 }, annotations: remoteSyncAnnotation.of(true) })
        this.status = 'CONNECTED'
        this.configureAccess()
      } else {
        if (!this.active()) { this.stop('DESYNCED'); return }
        const result = onServerOp(this.state, message, this.view.state.selection.main.head)
        this.state = result.state
        if (result.reloadRequired) { this.stop('DESYNCED'); return }
        if (result.replaceDocument) this.view.dispatch({
          changes: { from: 0, to: this.view.state.doc.length, insert: this.state.text },
          selection: { anchor: result.caret ?? 0 }, annotations: remoteSyncAnnotation.of(true),
        })
      }
      this.assertDocument()
      this.publish()
    } catch { this.stop('DESYNCED') }
  }
  private readonly closed = () => { if (!this.disposed) this.stop('DISCONNECTED') }
  private stop(status: 'DESYNCED' | 'DISCONNECTED'): void {
    if (this.disposed) return
    if (this.status === 'DESYNCED' || status === 'DESYNCED') {
      this.status = 'DESYNCED'
      console.error('Desynced: reload the tab')
    } else this.status = status
    this.incoming.clear()
    this.outgoing.clear()
    this.configureAccess()
    this.publish()
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close()
  }
  setLatency(latency: number): void {
    this.incoming.setLatency(latency)
    this.outgoing.setLatency(latency)
  }
  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    this.incoming.clear()
    this.outgoing.clear()
    this.socket.removeEventListener('open', this.open)
    this.socket.removeEventListener('message', this.message)
    this.socket.removeEventListener('close', this.closed)
    this.socket.removeEventListener('error', this.closed)
    this.socket.close()
    this.view.destroy()
  }
}
