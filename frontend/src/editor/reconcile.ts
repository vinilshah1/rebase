import { IdList, type ElementId, type SavedIdList } from 'articulated'

interface OpBase { readonly opId: string; readonly clientId: string }
export interface InsertOp extends OpBase {
  readonly type: 'insert'
  readonly beforeId: ElementId | null
  readonly newId: ElementId
  readonly count: number
  readonly content: string
}
export interface DeleteOp extends OpBase {
  readonly type: 'delete'
  readonly targetIds: readonly ElementId[]
}
export type ClientOp = InsertOp | DeleteOp
export type ServerOp = ClientOp & { readonly seq: number }
export interface DocumentState { readonly idList: IdList; readonly text: string }
export interface ReconcileState {
  readonly serverState: DocumentState
  readonly localIdList: IdList
  readonly text: string
  readonly pendingOps: readonly ClientOp[]
  readonly lastSeq: number
  readonly status: 'UNINITIALIZED' | 'READY' | 'DESYNCED'
}
export interface InitSnapshot {
  type: 'init'; seq: number; text: string; idListState: SavedIdList
}
export function createState(): ReconcileState {
  const idList = IdList.new()
  return { serverState: { idList, text: '' }, localIdList: idList, text: '', pendingOps: [], lastSeq: 0, status: 'UNINITIALIZED' }
}
export function initialize(state: ReconcileState, snapshot: InitSnapshot): ReconcileState {
  if (state.status === 'DESYNCED') return state
  const idList = IdList.load(snapshot.idListState)
  if (idList.length !== snapshot.text.length) throw new Error('Invalid snapshot length')
  return { serverState: { idList, text: snapshot.text }, localIdList: idList, text: snapshot.text, pendingOps: [], lastSeq: snapshot.seq, status: 'READY' }
}

/** Shared immutable application path; text positions count UTF-16 code units. */
export function applyOp(idList: IdList, text: string, op: ClientOp): DocumentState {
  if (op.type === 'insert') {
    if (op.count !== op.content.length || op.count < 1) throw new Error('Invalid insert count')
    const index = op.beforeId === null ? 0 : idList.indexOf(op.beforeId, 'left') + 1
    return { idList: idList.insertAfter(op.beforeId, op.newId, op.count), text: text.slice(0, index) + op.content + text.slice(index) }
  }
  for (const id of op.targetIds) {
    if (!idList.isKnown(id)) throw new Error('Unknown deletion target')
    if (idList.has(id)) {
      const index = idList.indexOf(id)
      text = text.slice(0, index) + text.slice(index + 1)
      idList = idList.delete(id)
    }
  }
  return { idList, text }
}

/** Positions refer to the intermediate document (CodeMirror's fromB). */
export interface LocalChange { readonly from: number; readonly deleteCount: number; readonly insert: string }
export interface Allocator {
  readonly clientId: string
  opId(): string
  generateAfter(beforeId: ElementId | null, count: number): ElementId
}
export function onLocalChange(state: ReconcileState, changes: readonly LocalChange[], allocator: Allocator): { state: ReconcileState; ops: ClientOp[] } {
  if (state.status !== 'READY') return { state, ops: [] }
  let idList = state.localIdList
  let text = state.text
  const ops: ClientOp[] = []
  const append = (op: ClientOp) => {
    const next = applyOp(idList, text, op)
    idList = next.idList
    text = next.text
    ops.push(op)
  }
  for (const change of changes) {
    if (!Number.isInteger(change.from) || !Number.isInteger(change.deleteCount) || change.from < 0 || change.deleteCount < 0 || change.from + change.deleteCount > idList.length) throw new Error('Invalid local range')
    if (change.deleteCount) {
      const targetIds = Array.from({ length: change.deleteCount }, (_, i) => idList.at(change.from + i))
      append({ type: 'delete', clientId: allocator.clientId, opId: allocator.opId(), targetIds })
    }
    if (change.insert.length) {
      const beforeId = change.from === 0 ? null : idList.at(change.from - 1)
      append({ type: 'insert', clientId: allocator.clientId, opId: allocator.opId(), beforeId, newId: allocator.generateAfter(beforeId, change.insert.length), count: change.insert.length, content: change.insert })
    }
  }
  return { state: { ...state, localIdList: idList, text, pendingOps: [...state.pendingOps, ...ops] }, ops }
}
export interface ServerResult {
  state: ReconcileState
  reloadRequired: boolean
  replaceDocument: boolean
  caret?: number
}
export function onServerOp(state: ReconcileState, op: ServerOp, caret?: number): ServerResult {
  const result = (next: ReconcileState, replaceDocument = false, restoredCaret?: number): ServerResult => ({ state: next, reloadRequired: next.status === 'DESYNCED', replaceDocument, caret: restoredCaret })
  if (state.status !== 'READY') return result(state)
  if (op.seq !== state.lastSeq + 1) return result({ ...state, status: 'DESYNCED' })
  try {
    const serverState = applyOp(state.serverState.idList, state.serverState.text, op)
    if (state.pendingOps[0]?.opId === op.opId) {
      return result({ ...state, serverState, lastSeq: op.seq, pendingOps: state.pendingOps.slice(1) })
    }
    const cursor = caret === undefined ? undefined : state.localIdList.cursorAt(caret, 'left')
    let local = serverState
    for (const pending of state.pendingOps) local = applyOp(local.idList, local.text, pending)
    return result({ ...state, serverState, lastSeq: op.seq, localIdList: local.idList, text: local.text }, true, cursor === undefined ? undefined : local.idList.cursorIndex(cursor, 'left'))
  } catch {
    return result({ ...state, status: 'DESYNCED' })
  }
}
