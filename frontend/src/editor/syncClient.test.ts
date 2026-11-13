import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { IdList } from 'articulated'
import { SyncClient, remoteSyncAnnotation, type Telemetry } from './syncClient'

// Exercise real CodeMirror transactions and extensions without a DOM renderer.
vi.mock('@codemirror/view', async importOriginal => {
  const original = await importOriginal<typeof import('@codemirror/view')>()
  class TestView {
    static lineWrapping = original.EditorView.lineWrapping
    static contentAttributes = original.EditorView.contentAttributes
    static editorAttributes = original.EditorView.editorAttributes
    static editable = original.EditorView.editable
    static updateListener = original.EditorView.updateListener
    state: EditorState
    destroyed = false
    transactions: Transaction[] = []
    constructor(config: { state: EditorState }) { this.state = config.state }
    dispatch(spec: TransactionSpec) {
      const startState = this.state
      const tr = this.state.update(spec)
      this.state = tr.state
      this.transactions.push(tr)
      const update = { state: this.state, startState, transactions: [tr], docChanged: tr.docChanged, changes: tr.changes }
      for (const listener of this.state.facet(original.EditorView.updateListener)) listener(update as import('@codemirror/view').ViewUpdate)
    }
    destroy() { this.destroyed = true }
  }
  return { ...original, EditorView: TestView }
})
class Socket extends EventTarget {
  static OPEN = 1
  static CLOSING = 2
  static instances: Socket[] = []
  readyState = 0
  sent: Record<string, unknown>[] = []
  url: string
  constructor(url: string) { super(); this.url = url; Socket.instances.push(this) }
  send(value: string) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
}
let client: SyncClient
let socket: Socket
let telemetry: Telemetry
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
  Socket.instances = []
  client = new SyncClient({} as HTMLElement, 'lag-test', 0, value => { telemetry = value })
  socket = Socket.instances[0]!
})
afterEach(() => { client.destroy(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function init(text = 'abc', seq = 0) {
  socket.open()
  const ids = IdList.new().insertAfter(null, { bunchId: 'initial', counter: 0 }, text.length)
  socket.message({ type: 'init', seq, text, idListState: ids.save() })
  await vi.runAllTimersAsync()
  return ids
}
function echo(index: number, seq: number) { socket.message({ ...socket.sent[index], seq }) }
it('creates one socket, gates edits until init, annotates the snapshot and cleans up', async () => {
  expect(Socket.instances).toHaveLength(1)
  expect(socket.url).toBe('ws://localhost:5173/ws/doc/lag-test/')
  client.view.dispatch({ changes: { from: 0, insert: 'blocked' } })
  expect(client.view.state.doc.length).toBe(0)
  await init()
  expect(telemetry.status).toBe('CONNECTED')
  expect(telemetry.characters).toBe(3)
  expect(telemetry.idListLength).toBe(3)
  expect(socket.sent).toEqual([])
  expect(client.view.state.readOnly).toBe(false)
  const view = client.view as unknown as { transactions: Transaction[]; destroyed: boolean }
  expect(view.transactions.some(tr => tr.annotation(remoteSyncAnnotation))).toBe(true)
  client.setLatency(100)
  client.view.dispatch({ changes: { from: 3, insert: 'queued' } })
  client.destroy()
  await vi.runAllTimersAsync()
  expect(socket.sent).toEqual([])
  expect(socket.readyState).toBe(3)
  expect(view.destroyed).toBe(true)
})
it('normalizes fromB, sends senderId without seq, and preserves later pending edits on echo', async () => {
  await init('abcdef')
  client.view.dispatch({ changes: [{ from: 0, to: 1, insert: 'XYZ' }, { from: 3, to: 5, insert: '!' }] })
  expect(client.view.state.doc.toString()).toBe('XYZbc!f')
  expect(telemetry.pendingOps.map(op => op.type)).toEqual(['delete', 'insert', 'delete', 'insert'])
  expect(telemetry.invariantBroken).toBe(false)
  await vi.runAllTimersAsync()
  socket.sent.forEach(op => { expect(op).not.toHaveProperty('seq'); expect(op).not.toHaveProperty('clientId'); expect(op.senderId).toBeTruthy() })
  const transactions = (client.view as unknown as { transactions: Transaction[] }).transactions.length
  echo(0, 1)
  await vi.runAllTimersAsync()
  expect(telemetry.pendingOps).toHaveLength(3)
  expect((client.view as unknown as { transactions: Transaction[] }).transactions).toHaveLength(transactions)
  expect(client.view.state.doc.toString()).toBe('XYZbc!f')
})
it('reconciles remote before own echo without sending the replacement and restores the caret', async () => {
  const ids = await init()
  client.view.dispatch({ changes: { from: 3, insert: 'x' }, selection: { anchor: 4 } })
  await vi.runAllTimersAsync()
  socket.message({ type: 'delete', senderId: 'remote', opId: 'remote', targetIds: [ids.at(2)], seq: 1 })
  await vi.runAllTimersAsync()
  expect(client.view.state.doc.toString()).toBe('abx')
  expect(client.view.state.selection.main.head).toBe(3)
  expect(socket.sent).toHaveLength(1)
  echo(0, 2)
  await vi.runAllTimersAsync()
  expect(telemetry.pendingOps).toEqual([])
  expect(client.view.state.doc.toString()).toBe('abx')
})
it('restores a caret whose anchor is remotely deleted, then follows the same character after insertion', async () => {
  const ids = await init()
  client.view.dispatch({ selection: { anchor: 3 } })
  socket.message({ type: 'delete', senderId: 'r', opId: 'd', targetIds: [ids.at(2)], seq: 1 })
  await vi.runAllTimersAsync()
  expect(client.view.state.selection.main.head).toBe(2)
  socket.message({ type: 'insert', senderId: 'r', opId: 'i', beforeId: null, newId: { bunchId: 'r', counter: 0 }, count: 1, content: 'R', seq: 2 })
  await vi.runAllTimersAsync()
  expect(client.view.state.selection.main.head).toBe(3)
  expect(client.view.state.doc.toString()).toBe('Rab')
  expect(socket.sent).toEqual([])
})
it.each([7, 5])('fatal seq %s stops both queues and survives the socket close event', async seq => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await init('abc', 5)
  socket.message({ type: 'delete', senderId: 'r', opId: 'bad', targetIds: [], seq })
  client.setLatency(100)
  client.view.dispatch({ changes: { from: 3, insert: 'queued' } })
  await vi.runAllTimersAsync()
  expect(telemetry.status).toBe('DESYNCED')
  expect(client.view.state.readOnly).toBe(true)
  client.view.dispatch({ changes: { from: 0, insert: 'blocked' } })
  expect(client.view.state.doc.toString()).toBe('abcqueued')
  expect(socket.sent).toEqual([])
  expect(socket.readyState).toBe(3)
  vi.restoreAllMocks()
})
it('uses separate latency queues and freezes on disconnect without reconnecting', async () => {
  await init()
  client.setLatency(100)
  client.view.dispatch({ changes: { from: 3, insert: 'x' } })
  await vi.advanceTimersByTimeAsync(99)
  expect(socket.sent).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(socket.sent).toHaveLength(1)
  echo(0, 1)
  await vi.advanceTimersByTimeAsync(99)
  expect(telemetry.pendingOps).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(telemetry.pendingOps).toHaveLength(0)
  socket.close()
  expect(telemetry.status).toBe('DISCONNECTED')
  expect(client.view.state.readOnly).toBe(true)
  expect(Socket.instances).toHaveLength(1)
  expect(client.view.state.facet(EditorView.editable)).toBe(false)
})
