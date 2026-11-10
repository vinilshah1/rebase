# Role & Objective

You are a Staff Distributed Systems and Full-Stack Engineer. We are building **Phase 1 (the Synchronization Engine Proof of Concept)** of a real-time collaborative Markdown note-taking app.

Instead of a black-box CRDT library like Yjs, we implement **Matthew Weidner's centralized server-reconciliation algorithm** ("Collaborative Text Editing without CRDTs or OT") using **`articulated` (`IdList`)** + **CodeMirror 6** on the frontend, and **Django Channels (ASGI + WebSockets)** with a custom Python port of `IdListSimple` on the backend.

Your goal: implement the backend and frontend PoC on top of the environment the human already scaffolded (Step 0), keep every static check clean (`ruff`, `basedpyright`, `tsc`), and pass the automated convergence tests.

---

## 0. Working Agreement (read first)

- Execute the steps in Section 6 **in order**. **Commit after each step** (`step N: <summary>`). Run `./scripts/check.sh` before every commit; it must pass.
- **If the same check fails twice in a row, STOP** and report what you tried and what you think is wrong. Do not spiral.
- The human owns the environment (Step 0). Do **not** edit `flake.nix`, tool settings in `pyproject.toml`, dependencies in `pyproject.toml`/`package.json`, `tsconfig*.json`, `vite.config.ts`, `core/settings.py`, or `scripts/check.sh`. Do not loosen lint/type rules. If a step truly needs a change to one of these, ask first.
- Do not build anything in "Out of Scope" and do not "fix" anything in "Known Limitations" (Section 7).
- If this spec contradicts the installed `articulated` type declarations, the type declarations win; stop and tell the human what differs.

---

## 1. Scope ("The Two-Tab Lag Test")

**Included:**
1. Python port of `IdListSimple` (`backend/sync/id_list.py`) matching the semantics and `SavedIdList` JSON format of the `articulated` npm package.
2. Stateful in-memory `RoomManager` in Django Channels, protected by a per-document `asyncio.Lock()`.
3. CodeMirror 6 plain-text editor integrated with `articulated`'s persistent `IdList`, `ElementIdGenerator`, optimistic local edits, a `pendingOps` queue, O(1) rollback reconciliation, and cursor preservation across remote edits.
4. Developer Telemetry Bar: **Simulated Network Latency Slider (0ms-2000ms)** and a live `pendingOps` inspector.
5. Automated tests: Python unit/property/differential tests, consumer-level tests, and a TypeScript simulation of N clients under random interleavings.

**Out of Scope (do NOT build):** authentication, PostgreSQL/any database models, REST APIs, multi-document dashboards, Typora-style Markdown syntax hiding, Redis/`channels_redis`, persistence across server restarts, CI/CD, undo/redo, reconnection logic.

**Definition of done:** two browser tabs on the same room with 1500ms simulated latency can type, paste, and delete inside the same word, and after the network drains both tabs show the identical string, no characters are lost, and neither tab's cursor jumps unexpectedly. All checks in `./scripts/check.sh` pass.

---

## 2. Repository Structure

Already scaffolded by the human (Step 0). You create the files marked `NEW`.

```text
.
├── flake.nix
├── scripts/check.sh               # ruff + basedpyright + pytest + tsc + vitest
├── shared/fixtures/               # cross-language test vectors (NEW contents)
├── backend/
│   ├── pyproject.toml
│   ├── manage.py
│   ├── core/                      # settings.py done by human; asgi.py routing is YOURS
│   └── sync/
│       ├── id_list.py             # NEW  Python port of IdListSimple + save/load
│       ├── room_manager.py        # NEW  canonical in-memory state + lock per room
│       ├── consumers.py           # NEW  AsyncWebsocketConsumer
│       ├── routing.py             # NEW
│       ├── test_id_list.py        # NEW
│       ├── test_room.py           # NEW
│       └── test_consumer.py       # NEW
└── frontend/
    ├── package.json
    ├── scripts/gen-fixtures.ts    # NEW  produces shared/fixtures/idlist_vectors.json
    └── src/
        ├── main.tsx               # NO <StrictMode> wrapper (see 3.H)
        ├── App.tsx                # NEW  shell + latency slider
        └── editor/
            ├── CollaborativeEditor.tsx  # NEW
            ├── syncClient.ts            # NEW  WS + CodeMirror glue (thin)
            ├── reconcile.ts             # NEW  PURE logic: applyOp, onLocalChange, onServerOp
            ├── delayPipe.ts             # NEW  FIFO latency simulator
            └── *.test.ts                # NEW  vitest
```

The dev environment is loaded by direnv (`.envrc` with `use flake`) and inherited by this session. Run all commands from the repo root. Tools (`uv`, `ruff`, `basedpyright`, `node`, `npx`) are already on PATH. If any of them is missing or "command not found", **stop and tell the human**. Do not install anything, do not run `nix develop` or `nix shell` yourself, and do not work around it. There is no Docker.

---

## 3. Core Technical Architecture & Algorithm Rules

### A. Dual State Representation (`IdList` + plain string)

`IdList` does **not** store characters. It tracks element identities `{ bunchId: string, counter: number }` and deletion flags, acting as an index-to-ID translator alongside the plain text string.

**Invariants (assert them in code and tests):**
- **I1:** `localIdList.length === view.state.doc.length` whenever control returns to the event loop.
- **I2:** `serverState.idList.length === serverState.text.length`, and on the server `len(id_list) == len(text)` after every op.
- **I3:** local state is always equal to `replay(pendingOps)` applied on top of `serverState`.

**Tombstones:** deleted elements stay in the list with `isDeleted = true` (`isKnown(id) === true`, `has(id) === false`) so concurrent operations anchored on a recently deleted `beforeId` still resolve.

**Text units are UTF-16 code units everywhere.** CodeMirror positions and JS `string.length` count UTF-16 units; one emoji = 2 units = 2 element ids. The Python server must therefore store text as a `list[str]` where each item is **one UTF-16 code unit** (surrogate halves are lone-surrogate `str`s). Provide helpers `utf16_units(s: str) -> list[str]` (encode with `"utf-16-le"` + `"surrogatepass"`) and `utf16_len(s)`. When sending JSON, use `json.dumps` with the default `ensure_ascii=True` (never `False`) so surrogate halves serialize as `\ud83d\ude00`-style escapes that JS reassembles correctly.

### B. Frontend API facts (`articulated`, verified against v1.4.0)

Types live in `node_modules/articulated/build/esm/*.d.ts` (**not** `dist/`). Do not re-read them in full; skim only if something below fails.

- `IdList.new()`, `IdList.load(saved)`, `list.save()`.
- `SavedIdList = Array<{ bunchId: string; startCounter: number; count: number; isDeleted: boolean }>`, in list order. Runs of sequential counters with the same `bunchId` and `isDeleted` are merged. `count: 0` entries are legal. Duplicate ids are illegal (`load` throws).
- `insertAfter(before: ElementId | null, newId, count = 1)`: `null` means the very start (left of all known ids, tombstones included). Inserts immediately after `before` in known-list order. **Throws** if `before` is unknown or any inserted id is already known. Returns a new `IdList`.
- `delete(id, count = 1)`: no-op if already deleted or unknown. Returns a new `IdList`.
- `has(id)` (present and not deleted), `isKnown(id)`, `length` (present ids only), `at(index)` (throws if out of bounds).
- `indexOf(id, bias)`: throws if `id` is unknown. If present, returns its index for every bias. If deleted: `"none"` -> `-1`; `"left"` -> index of the nearest present element to its left (possibly `-1`); `"right"` -> the index where it would be if present (possibly `length`).
- `cursorAt(index, "left")` and `cursorIndex(cursor, "left")` convert between a visible index and a stable anchor id (`null` = start). **Use these for cursor preservation.** `cursorIndex(id, "left")` is exactly `indexOf(id, "left") + 1`.
- `ElementIdGenerator(() => crypto.randomUUID())`; `generateAfter(beforeId, count)` returns only the first id and reserves the rest. Ops carry `newId` + `count`; **replaying an op never calls the generator again.**
- **`IdListSimple` is not exported by the npm package.** The real `IdList` is the oracle for the Python port (see differential tests, Section 5).

**THE position rule (use everywhere, client and server):**

```text
visibleIndexAfter(beforeId) = beforeId === null ? 0 : indexOf(beforeId, "left") + 1
```

Do **not** use `indexOf(beforeId, "right") + 1`: when the anchor is a tombstone, `"right"` already points at the insertion slot and `+ 1` is off by one.

### C. Python Backend Port (`backend/sync/id_list.py`)

Clean, strictly typed (`basedpyright`-clean) port of `IdListSimple`. O(n) operations are fine for the PoC.

1. `@dataclass(frozen=True) class ElementId(bunch_id: str, counter: int)`; internal `@dataclass class Element(bunch_id: str, counter: int, is_deleted: bool)` stored in a flat `list[Element]` in known-list order.
2. `class IdListError(ValueError)` for protocol/semantic failures.
3. `insert_after(before_id: ElementId | None, new_id: ElementId, count: int = 1) -> None`: ids are `new_id.counter ... new_id.counter + count - 1` with the same bunch. Raise `IdListError` if `count < 1`, `before_id` is not `None` and unknown, or **any** of the new ids is already known. **Validate everything before mutating** (atomic).
4. `delete(target_id)`: no-op if unknown or already deleted (matches articulated).
5. `has`, `is_known`, `at(index) -> ElementId` (raise `IndexError` out of bounds), `index_of(target_id, bias: Literal["none","left","right"] = "none") -> int` (raise `IdListError` if unknown; semantics exactly as in 3.B), `__len__` (present only), `known_length`.
6. `visible_index_after(before_id: ElementId | None) -> int` implementing the position rule.
7. `save() -> list[SavedRun]` where `SavedRun` is a `TypedDict` with **camelCase** keys `bunchId, startCounter, count, isDeleted`, merging adjacent same-bunch/same-`isDeleted`/sequential-counter elements. `load(saved)` (classmethod) validates the rules in 3.B and raises `IdListError`. Round trips are compared **semantically** (expanded `(bunch, counter, deleted)` sequence), not byte-for-byte.
8. A test helper `expand() -> list[tuple[str, int, bool]]`.

### D. Wire Protocol (JSON over WebSocket `/ws/doc/<room_name>/`)

`room_name` matches `[A-Za-z0-9_-]{1,64}` (Channels group names must be ASCII and short; the group is `doc_<room_name>`).

1. **Server -> Client on connect (`init`):**
   ```json
   { "type": "init", "seq": 0, "text": "…", "idListState": [ ... ] }
   ```
   `seq` is the room's op counter at snapshot time.

2. **`insert`** (client -> server, then server -> all clients including the sender, with `seq` added):
   ```json
   {
     "type": "insert", "opId": "uuid", "senderId": "client_uuid",
     "beforeId": { "bunchId": "...", "counter": 0 } | null,
     "newId": { "bunchId": "...", "counter": 1 },
     "count": 5, "content": "hello", "seq": 17
   }
   ```
   Validation: `count === utf16_len(content)`, `1 <= count <= 100_000`, counters are non-negative integers, ids are strings <= 128 chars.

3. **`delete`** (same routing). One element id per deleted character (no range encoding):
   ```json
   {
     "type": "delete", "opId": "uuid", "senderId": "client_uuid",
     "targetIds": [{ "bunchId": "...", "counter": 3 }], "seq": 18
   }
   ```
   Validation: `1 <= len(targetIds) <= 100_000`. A client can only reference ids it learned from the server or created itself earlier on the same socket, so an **unknown** target id is a protocol violation, not a no-op.

4. **Invalid input** (bad JSON, bad shape, unknown `beforeId`, already-known `newId`, unknown delete target, count mismatch): validate **before** mutating anything, log the reason, close the socket with code `4400`, and neither mutate the room nor broadcast. The consumer must never crash or leave the room half-updated.

### E. Server Sequencing & Idempotency (`consumers.py`, `room_manager.py`)

1. `Room` holds `lock = asyncio.Lock()`, `id_list`, `text: list[str]`, `seq: int`. `RoomManager.get_or_create(name)` is a synchronous dict lookup-or-insert (no `await` between check and insert, so it is race-free in the single event loop). Rooms live in memory for the process lifetime.
2. **`connect()`:** `accept()`, then `async with room.lock:` -> `group_add` -> send `init` (with `seq`). Because ops are applied *and broadcast* under the same lock, a late joiner's snapshot is consistent with exactly the broadcasts it will receive afterwards.
3. **`insert`:** `async with room.lock:` validate -> `idx = id_list.visible_index_after(beforeId)` **computed before inserting** -> `id_list.insert_after(...)` -> splice `utf16_units(content)` into `text` at `idx` -> `seq += 1` -> **`await group_send(...)` still inside the lock** so broadcast order equals apply order.
4. **`delete`:** `async with room.lock:` validate that every target is known (reject the whole op otherwise) -> for each `target_id`: **if `id_list.has(target_id)`**, `idx = index_of(target_id, "none")`, remove `text[idx]`, then `id_list.delete(target_id)`; otherwise leave `text` untouched (already deleted by a concurrent op) -> `seq += 1` -> `group_send` inside the lock.
5. After every applied op, check I2; on violation log loudly and close with code `4500`.
6. Run as **one process, one worker**. Channel layer is `InMemoryChannelLayer` only (configured by the human). Per-process lock and in-memory layer are only correct with a single worker.

### F. Client Reconciliation & Cursor Preservation

Put all logic in a **pure module `reconcile.ts`** (no DOM, no WebSocket, no CodeMirror view) so it can be tested in isolation. `syncClient.ts` is a thin adapter around it.

State: `serverState: { idList, text }`, `localIdList`, `pendingOps: Op[]` (FIFO), `lastSeq`. CodeMirror's `view.state.doc` holds the live local text.

`applyOp(idList, text, op) -> { idList, text }` is the single shared implementation (JS strings are UTF-16 so slicing is fine):
- `insert`: `idx = visibleIndexAfter(beforeId)`; `idList = idList.insertAfter(beforeId, newId, count)`; splice `content` into `text` at `idx`.
- `delete`: for each target: `if (idList.has(id)) { idx = idList.indexOf(id); remove text[idx]; idList = idList.delete(id) }`, else skip.

1. **On local CodeMirror edit** (`EditorView.updateListener`):
   - Return early unless `update.docChanged`.
   - Ignore updates containing a transaction tagged with `remoteSyncAnnotation = Annotation.define<boolean>()`.
   - **Do not dispatch from inside the listener.**
   - Process `update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => ...)` **in order, mutating `localIdList` as you go.** `fromA/toA` are positions in the *original* document and become stale once an earlier change in the same update has been applied. When a change is processed, all earlier changes are already applied, so this change sits at index **`fromB`** of the intermediate document. Use `fromB` as the position for both steps below, never `fromA`.
   - **Deletion** of `toA - fromA` characters: first collect `ids = [at(fromB), …, at(fromB + toA - fromA - 1)]` from the *unmodified* list (deleting shifts indices, so collect first), then delete each, and queue **one** `delete` op with all `targetIds`.
   - **Insertion** of `text = inserted.toString()` (skip if empty): `beforeId = fromB === 0 ? null : localIdList.at(fromB - 1)` (after the deletion above); `newId = idGen.generateAfter(beforeId, text.length)`; `localIdList = localIdList.insertAfter(beforeId, newId, text.length)`; queue an `insert` op.
   - A replacement therefore emits a `delete` op followed by an `insert` op, in that order.
   - Push every op to `pendingOps` and send it through the outgoing `DelayPipe`.

2. **On server op** (after the incoming `DelayPipe`):
   - **Step 0:** assert `op.seq === lastSeq + 1` (init sets `lastSeq`). A gap or reorder is a bug: surface it in telemetry and log it.
   - **Step 1 (advance server state):** `serverState = applyOp(serverState, op)`.
   - **Step 2 (fast path):** if `pendingOps[0]?.opId === op.opId`, shift it off and **return**. The optimistic state already matches.
   - **Step 3 (reconcile; a remote op arrived):**
     1. **Save cursor:** `anchor = localIdList.cursorAt(view.state.selection.main.head, "left")` (call this *before* rolling back).
     2. **Rollback:** `localIdList = serverState.idList; workingText = serverState.text`.
     3. **Replay** every op in `pendingOps` in order with `applyOp`, using each op's stored ids (never regenerate).
     4. **Restore:** `newHead = localIdList.cursorIndex(anchor, "left")`. Dispatch one transaction: `changes: { from: 0, to: doc.length, insert: workingText }`, `selection: { anchor: newHead }`, `annotations: remoteSyncAnnotation.of(true)`.

3. `clientId = crypto.randomUUID()` per tab; `opId = crypto.randomUUID()` per op. Use `localhost` (not a LAN IP) so `crypto.randomUUID` is available.

### G. Latency Simulator (`delayPipe.ts`)

A generic `DelayPipe<T>` with **strict FIFO delivery**. On `push(item)`: `deliverAt = Math.max(performance.now() + currentLatencyMs, lastDeliverAt)`; remember `lastDeliverAt = deliverAt`. A naive independent `setTimeout(latency)` per message is wrong: if the slider is lowered mid-flight, later messages overtake earlier ones and break the strict ordering that server-state replay assumes. Use two pipes (outgoing, incoming). Changing the slider only affects messages pushed afterwards.

### H. React / CodeMirror integration

- **No `<StrictMode>`** in `main.tsx` (dev double-mount would create two sockets and two `EditorView`s). Still clean up in the effect: close the socket and `view.destroy()`.
- Create the `EditorView` and the sync client exactly once per mount; never recreate them on re-render. Expose telemetry (`pendingOps`, `lastSeq`, `idList.length`, text length, connection state) via `useSyncExternalStore` or an equivalent subscribe mechanism.
- Extensions: `EditorView.lineWrapping`, `drawSelection()`, `keymap.of(defaultKeymap)`, the `updateListener`. **Do not use `basicSetup` and do not add `history()`** (see Section 7).
- The room name comes from `?room=<name>` in the page URL (default `poc`). WebSocket URL: `ws://${location.host}/ws/doc/${room}/` (Vite proxies `/ws` to Django; the human configured the proxy).
- If `idList.length !== text.length` ever happens (I1), show a red "INVARIANT BROKEN" badge in the telemetry bar.
- Connection loss: show "Disconnected: reload the tab". No reconnect logic.

---

## 4. UI / Visual Direction

ElevenLabs-inspired "quietly intelligent, tactile minimalism" with Tailwind CSS v4:

- **Canvas:** warm alabaster `#FAF9F6`, deep charcoal ink `#141413`, muted stone borders `#E5E5E0`, generous negative space, centered 68ch editorial column.
- **Top telemetry header (48px, 1px hair-thin bottom border):**
  - Left: title `PoC // Server Reconciliation Engine` + live badge: `Synced` in sage `#3D8C65`, or `Reconciling (N pending ops)...` in terracotta `#D96B43` when `pendingOps.length > 0`.
  - Right: monospace latency slider `0ms`-`2000ms` (delays both outgoing and incoming packets), character count, `idList.length` sanity counter.

---

## 5. Tests

**Python** (`pytest`, `pytest-asyncio`, `hypothesis`):
1. **Unit tests** for every `IdListSimple` method: null anchor, tombstone anchor, bulk insert, duplicate/unknown id errors (and atomicity: a failed insert leaves the list unchanged), idempotent delete, all three `index_of` biases on present and deleted ids, and the position rule on a tombstone anchor.
2. **Differential test vs `articulated`:** `frontend/scripts/gen-fixtures.ts` (run with `npx tsx`) generates a *seeded, reproducible* random sequence of `insertAfter`/`delete` operations (multiple bunches, bulk counts, deletes of already-deleted ids, anchors that are tombstones) using the real `IdList`, and writes `shared/fixtures/idlist_vectors.json`: the op list plus, at several checkpoints, `save()` output, the expanded known list, `at(i)` for every visible `i`, and `indexOf(id, bias)` for every known id and bias. The Python test replays the ops and asserts every value matches. Commit the generated fixture.
3. **Property tests (hypothesis):** random op sequences preserve I2-style invariants (`len == number of non-deleted`), `at(index_of(x)) == x` for present `x`, and `load(save(x))` is semantically equal to `x`.
4. **Cross-language round trip:** the Python test also writes `shared/fixtures/python_roundtrip.json` (Python's `save()` after replaying the fixture ops). A vitest asserts `IdList.load(thatJson)` expands to the same known list as the TypeScript reference. Run order in `check.sh` is pytest first, then vitest.
5. **Room-level concurrency test:** two simulated clients, A and B, both anchored at the **same `beforeId`**, issue concurrent inserts and overlapping deletes of the same targets. Apply the ops in both possible server orders. Assert: no exception, no double removal from `text`, I2 holds, and **late-joiner equivalence** (snapshot taken at op k via `save()`/`load()` plus ops k+1..n produces state identical to replaying all ops from scratch).
6. **Unicode test:** insert and delete text containing emoji (surrogate pairs) and verify `text` as UTF-16 units, `len(id_list)`, and indices agree with what JS would compute.
7. **Consumer tests** with `channels.testing.WebsocketCommunicator`: `init` shape; two communicators observe the identical broadcast sequence with consecutive `seq`; each invalid-input case in 3.D closes with `4400` and leaves the room unchanged.

**TypeScript** (`vitest`):
1. **`reconcile.test.ts`:** an in-process fake server (using the same `applyOp`) and 3 clients. Random edit scripts (typing, multi-character paste, range delete, replace, edits at the *same* anchor from multiple clients) with random message delivery interleavings that **preserve per-link FIFO order**. Assert I1-I3 after every delivery and that at quiescence all client texts equal the server text.
2. **Multi-change `iterChanges` test:** build a CodeMirror `ChangeSet` with several changes (including a multi-cursor-style edit and a replace-all) and assert that the ops produced by `onLocalChange`, replayed with `applyOp`, yield exactly CodeMirror's new document. This pins down the `fromB` rule.
3. **`delayPipe.test.ts`** (fake timers): FIFO holds when latency is lowered mid-flight.
4. **Python round-trip fixture test** (see Python test 4).
5. **Caret placement test**: with the caret at the end of the document, a remote op deletes the character the caret is anchored on. After reconcile, the caret equals the new document length (not past it). A second case: a remote insert before the caret leaves the caret after the same character.

**Optional stretch (only if everything else is green):** a Node script using the `ws` package that connects 3 clients to the real Django server, applies random edits with random delays, waits for quiescence, and asserts all final texts are equal.

---

## 6. Step-by-Step Execution Plan

0. **(Human, already done.)** the direnv/flake environment loads; `uv sync`/`npm install` done; Django settings stripped (no DB), Channels in-memory layer configured; Vite proxy, Tailwind, vitest, ruff/basedpyright/pytest configs in place; `./scripts/check.sh` passes on the empty skeleton.
1. Run `./scripts/check.sh` to confirm the baseline is green. Skim `node_modules/articulated/build/esm/id_list.d.ts` only if something in 3.B seems wrong. No commit needed if nothing changed.
2. Write `frontend/scripts/gen-fixtures.ts` and generate `shared/fixtures/idlist_vectors.json`. Commit.
3. Implement `backend/sync/id_list.py` and `test_id_list.py` (Python tests 1-4). Iterate until `ruff check`, `basedpyright`, and `pytest` are 100% clean. Commit.
4. Implement `room_manager.py`, `consumers.py`, `routing.py`, and the ASGI wiring in `core/asgi.py`, plus `test_room.py` and `test_consumer.py` (Python tests 5-7). Commit.
5. Implement `reconcile.ts`, `delayPipe.ts` and their vitest suites (TypeScript tests 1-4). `tsc --noEmit` and `vitest run` clean. Commit.
6. Implement `syncClient.ts`, `CollaborativeEditor.tsx`, `App.tsx`, and update `main.tsx` (no StrictMode). `tsc --noEmit` clean. Commit.
7. Run `./scripts/check.sh` one last time. Then print the exact commands for the Two-Tab Lag Test:
   - Backend (single worker, **no `--reload`**, because a reload wipes in-memory rooms): `cd backend && uv run uvicorn core.asgi:application --host 127.0.0.1 --port 8000`
   - Frontend: `cd frontend && npm run dev`
   - Open two tabs at `http://localhost:5173/?room=lag-test`, set the slider to ~1500ms in both, and edit the same word in both.
   Finish with a short report: what was built, what passed, anything you deviated on or are unsure about.
8. *(Optional)* the stretch soak test, if the human asks.

---

## 7. Known Limitations (do NOT fix unprompted)

- Every remote op replaces the whole CodeMirror document. This clears undo history (hence no `history()`), collapses range selections to a caret at the preserved head, and would break IME composition. A common-prefix/suffix diff would fix the first two, but it is deliberately deferred.
- Rooms are ephemeral: a server restart discards all documents.
- No reconnection, no auth, no persistence, single process only.
- Per-character element ids and O(n) Python `IdListSimple` are acceptable at PoC scale.
