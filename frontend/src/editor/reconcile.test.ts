import { describe, expect, it } from 'vitest'
import { ChangeSet, Text } from '@codemirror/state'
import { ElementIdGenerator, IdList } from 'articulated'
import { applyOp, createState, initialize, onLocalChange, onServerOp, type ClientOp, type DocumentState, type ReconcileState, type ServerOp } from './reconcile'

function ready(text = 'abc', seq = 0) {
  const idList = text ? IdList.new().insertAfter(null, { bunchId: 'initial', counter: 0 }, text.length) : IdList.new()
  return initialize(createState(), { type: 'init', seq, text, idListState: idList.save() })
}
function allocator(clientId = 'a') {
  let n = 0
  const gen = new ElementIdGenerator(() => `${clientId}-b${n++}`)
  return { clientId, opId: () => `${clientId}-op${n++}`, generateAfter: (id: Parameters<typeof gen.generateAfter>[0], count: number) => gen.generateAfter(id, count) }
}
function invariant(s: ReconcileState) {
  expect(s.status).toBe('READY')
  let replay = s.serverState
  for (const op of s.pendingOps) replay = applyOp(replay.idList, replay.text, op)
  expect(s.text).toBe(replay.text)
  expect([...s.localIdList.valuesWithIsDeleted()]).toEqual([...replay.idList.valuesWithIsDeleted()])
  expect(s.text.length).toBe(s.localIdList.length)
  expect(s.serverState.text.length).toBe(s.serverState.idList.length)
}
function remote(s: ReconcileState, content = 'R'): ServerOp {
  return { type: 'insert', clientId: 'remote', opId: 'remote', beforeId: null, newId: { bunchId: 'remote', counter: 0 }, count: content.length, content, seq: s.lastSeq + 1 }
}
describe('reconciliation', () => {
  it('initializes explicitly and disables generation beforehand', () => {
    const a = allocator()
    expect(onLocalChange(createState(), [{ from: 0, deleteCount: 0, insert: 'x' }], a).ops).toEqual([])
    const s = ready('abc', 5)
    expect(s.serverState.text).toBe('abc')
    expect(s.localIdList).toBe(s.serverState.idList)
    expect(s.localIdList.save()).toEqual(ready().localIdList.save())
    expect(s.pendingOps).toEqual([])
    expect(s.lastSeq).toBe(5)
    invariant(s)
  })
  it('acknowledges only the head without rebuilding optimistic state', () => {
    let s = ready()
    const a = allocator()
    s = onLocalChange(s, [{ from: 3, deleteCount: 0, insert: 'x' }], a).state
    s = onLocalChange(s, [{ from: 4, deleteCount: 0, insert: 'y' }], a).state
    const list = s.localIdList
    const [first, second] = s.pendingOps
    s = onServerOp(s, { ...first!, seq: 1 }).state
    expect(s.serverState.text).toBe('abcx')
    expect(s.pendingOps).toEqual([second])
    expect(s.localIdList).toBe(list)
    invariant(s)
    const result = onServerOp(s, { ...second!, seq: 2 })
    expect(result.replaceDocument).toBe(false)
    expect(result.state.text).toBe('abcxy')
    expect(result.state.pendingOps).toEqual([])
    invariant(result.state)
  })
  it('replays dependent pending IDs after a remote op then drains own echoes', () => {
    const a = allocator()
    let s = onLocalChange(ready(), [{ from: 3, deleteCount: 0, insert: 'x' }], a).state
    s = onLocalChange(s, [{ from: 4, deleteCount: 0, insert: 'y' }], a).state
    const ops = s.pendingOps
    const result = onServerOp(s, remote(s), 5)
    expect(result.replaceDocument).toBe(true)
    expect(result.caret).toBe(6)
    s = result.state
    expect(s.text).toBe('Rabcxy')
    invariant(s)
    for (const op of ops) { s = onServerOp(s, { ...op, seq: s.lastSeq + 1 }).state; invariant(s) }
    expect(s.pendingOps).toEqual([])
    expect(s.text).toBe(s.serverState.text)
  })
  it.each([7, 5, 4])('fatally stops on sequence %s after 5', seq => {
    let s = ready('abc', 5)
    const r = onServerOp(s, { ...remote(s), seq })
    expect(r.reloadRequired).toBe(true)
    s = r.state
    expect(s.status).toBe('DESYNCED')
    expect(onServerOp(s, remote(s)).state).toBe(s)
    expect(onLocalChange(s, [{ from: 0, deleteCount: 0, insert: 'x' }], allocator()).ops).toEqual([])
  })
  it('uses centralized same-anchor order and left-biased tombstone insertion', () => {
    let s = ready()
    const anchor = s.localIdList.at(1)
    s = onServerOp(s, { ...remote(s, 'X'), beforeId: anchor }).state
    s = onServerOp(s, { ...remote(s, 'Y'), opId: 'y', newId: { bunchId: 'y', counter: 0 }, beforeId: anchor }).state
    expect(s.text).toBe('abYXc')
    let d = applyOp(s.localIdList, s.text, { type: 'delete', clientId: 'd', opId: 'd', targetIds: [anchor] })
    d = applyOp(d.idList, d.text, { ...remote(s, 'Z'), newId: { bunchId: 'z', counter: 0 }, beforeId: anchor })
    expect(d.text).toBe('aZYXc')
  })
  it('deletes UTF-16 units, preserves tombstones and rejects unknown targets', () => {
    const s = ready('a😀b')
    expect(s.text.length).toBe(4)
    const op: ClientOp = { type: 'delete', clientId: 'd', opId: 'd', targetIds: [s.localIdList.at(1), s.localIdList.at(2)] }
    const d = applyOp(s.localIdList, s.text, op)
    expect(d.text).toBe('ab')
    expect(applyOp(d.idList, d.text, op).text).toBe('ab')
    expect(() => applyOp(d.idList, d.text, { ...op, targetIds: [{ bunchId: 'unknown', counter: 0 }] })).toThrow()
  })
  it('restores an end caret when its anchor is deleted', () => {
    const s = ready()
    const r = onServerOp(s, { type: 'delete', clientId: 'r', opId: 'r', seq: 1, targetIds: [s.localIdList.at(2)] }, 3)
    expect(r.caret).toBe(2)
  })
  it('uses fromB for multiple CodeMirror changes and replace-all', () => {
    let s = ready('abcdef')
    for (const specs of [[{ from: 0, to: 1, insert: 'XYZ' }, { from: 3, to: 5, insert: '!' }], [{ from: 0, to: 7, insert: '😀 done' }]]) {
      const changes = ChangeSet.of(specs, s.text.length)
      const normalized: { from: number; deleteCount: number; insert: string }[] = []
      changes.iterChanges((fromA, toA, fromB, _toB, inserted) => normalized.push({ from: fromB, deleteCount: toA - fromA, insert: inserted.toString() }))
      const expected = changes.apply(Text.of([s.text])).toString()
      s = onLocalChange(s, normalized, allocator(`batch${s.pendingOps.length}`)).state
      expect(s.text).toBe(expected)
      invariant(s)
    }
  })
  it('converges three clients under seeded FIFO interleavings', () => {
    for (let seed = 1; seed <= 5; seed++) {
      let rng = seed
      const random = (n: number) => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return Math.floor(rng / 4294967296 * n) }
      const clients = [ready(), ready(), ready()]
      const allocators = clients.map((_, i) => allocator(`c${i}`))
      const outgoing: ClientOp[][] = [[], [], []]
      const incoming: ServerOp[][] = [[], [], []]
      const history: DocumentState[] = [ready().serverState]
      let server = history[0]!
      let seq = 0
      const deliver = () => {
        const i = random(3)
        if (random(2) && outgoing[i]!.length) {
          const op = outgoing[i]!.shift()!
          server = applyOp(server.idList, server.text, op)
          history.push(server)
          const broadcast = { ...op, seq: ++seq }
          incoming.forEach(q => q.push(broadcast))
        } else if (incoming[i]!.length) clients[i] = onServerOp(clients[i]!, incoming[i]!.shift()!).state
        clients.forEach(c => {
          invariant(c)
          expect(c.serverState.text).toBe(history[c.lastSeq]!.text)
          expect([...c.serverState.idList.valuesWithIsDeleted()]).toEqual([...history[c.lastSeq]!.idList.valuesWithIsDeleted()])
        })
      }
      for (let step = 0; step < 40; step++) {
        const i = random(3), s = clients[i]!
        const from = random(s.text.length + 1)
        const deleteCount = random(Math.min(3, s.text.length - from) + 1)
        const insert = ['', 'x', 'paste', '😀'][random(4)]!
        const r = onLocalChange(s, [{ from, deleteCount, insert }], allocators[i]!)
        clients[i] = r.state
        outgoing[i]!.push(...r.ops)
        deliver()
      }
      while ([...outgoing, ...incoming].some(q => q.length)) deliver()
      clients.forEach(c => { invariant(c); expect(c.pendingOps).toEqual([]); expect(c.text).toBe(server.text) })
    }
  })
})

it('loads Python-serialized fixture histories with the real frontend IdList', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const vectors = JSON.parse(readFileSync(`${root}/shared/fixtures/idlist_vectors.json`, 'utf8')) as { cases: { ops: ({ type: 'insert'; beforeId: import('articulated').ElementId | null; newId: import('articulated').ElementId; count: number } | { type: 'delete'; targetId: import('articulated').ElementId })[] }[] }
  const saved = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, sys.argv[1] + '/backend')
from sync.id_list import IdList, ElementId
cases = json.load(sys.stdin)['cases']
results = []
for case in cases:
    ids = IdList()
    for op in case['ops']:
        convert = lambda x: ElementId(x['bunchId'], x['counter'])
        if op['type'] == 'insert':
            ids.insert_after(None if op['beforeId'] is None else convert(op['beforeId']), convert(op['newId']), op['count'])
        else:
            ids.delete(convert(op['targetId']))
    results.append(ids.save())
print(json.dumps(results))
`, root], { input: JSON.stringify(vectors), encoding: 'utf8' })) as import('articulated').SavedIdList[]
  vectors.cases.forEach((fixture, i) => {
    let reference = IdList.new()
    for (const op of fixture.ops) reference = op.type === 'insert' ? reference.insertAfter(op.beforeId, op.newId, op.count) : reference.delete(op.targetId)
    expect([...IdList.load(saved[i]!).valuesWithIsDeleted()]).toEqual([...reference.valuesWithIsDeleted()])
  })
})
