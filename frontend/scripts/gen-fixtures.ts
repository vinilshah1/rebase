import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { IdList } from "articulated";
import type { ElementId, SavedIdList } from "articulated";

const SEED = 0x1d11_57;
const OP_COUNT = 50;
const CHECKPOINT_EVERY = 10;
const BUNCH_IDS = ["bunch-alpha", "bunch-beta", "bunch-gamma", "bunch-delta"];

type InsertOp = {
  type: "insert";
  beforeId: ElementId | null;
  newId: ElementId;
  count: number;
};

type DeleteOp = {
  type: "delete";
  targetId: ElementId;
};

type Op = InsertOp | DeleteOp;

type IndexOfEntry = {
  id: ElementId;
  none: number;
  left: number;
  right: number;
};

type Checkpoint = {
  opCount: number;
  save: SavedIdList;
  known: Array<[string, number, boolean]>;
  at: ElementId[];
  indexOf: IndexOfEntry[];
};

type Fixture = {
  format: "idlist-vectors-v1";
  seed: number;
  ops: Op[];
  checkpoints: Checkpoint[];
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);

function randomInt(maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function choose<T>(items: readonly T[]): T {
  const item = items[randomInt(items.length)];
  if (item === undefined) throw new Error("cannot choose from an empty array");
  return item;
}

let idList = IdList.new();
const nextCounters = new Map<string, number>();
const ops: Op[] = [];
const checkpoints: Checkpoint[] = [];

function checkpoint(): void {
  const known = Array.from(idList.valuesWithIsDeleted());
  checkpoints.push({
    opCount: ops.length,
    save: idList.save(),
    known: known.map(({ id, isDeleted }) => [
      id.bunchId,
      id.counter,
      isDeleted,
    ]),
    at: Array.from({ length: idList.length }, (_, index) =>
      idList.at(index),
    ),
    indexOf: known.map(({ id }) => ({
      id,
      none: idList.indexOf(id, "none"),
      left: idList.indexOf(id, "left"),
      right: idList.indexOf(id, "right"),
    })),
  });
}

checkpoint();

for (let step = 0; step < OP_COUNT; step++) {
  const known = Array.from(idList.valuesWithIsDeleted());
  const present = known.filter(({ isDeleted }) => !isDeleted);
  const deleted = known.filter(({ isDeleted }) => isDeleted);

  const shouldInsert = known.length === 0 || rng() < 0.6;

  if (shouldInsert) {
    const bunchId = choose(BUNCH_IDS);
    const startCounter = nextCounters.get(bunchId) ?? 0;
    const count = 1 + randomInt(4);

    let beforeId: ElementId | null;
    if (known.length === 0) {
      beforeId = null;
    } else {
      const roll = rng();
      if (roll < 0.12) {
        beforeId = null;
      } else if (roll < 0.52 && deleted.length > 0) {
        beforeId = choose(deleted).id;
      } else {
        beforeId = choose(known).id;
      }
    }

    const newId: ElementId = { bunchId, counter: startCounter };
    idList = idList.insertAfter(beforeId, newId, count);
    nextCounters.set(bunchId, startCounter + count);
    ops.push({ type: "insert", beforeId, newId, count });
  } else {
    let targetId: ElementId;
    if (deleted.length > 0 && rng() < 0.35) {
      targetId = choose(deleted).id;
    } else if (present.length > 0) {
      targetId = choose(present).id;
    } else {
      targetId = choose(known).id;
    }
    idList = idList.delete(targetId);
    ops.push({ type: "delete", targetId });
  }

  if (ops.length % CHECKPOINT_EVERY === 0) checkpoint();
}

if (ops.length % CHECKPOINT_EVERY !== 0) checkpoint();

const fixture: Fixture = {
  format: "idlist-vectors-v1",
  seed: SEED,
  ops,
  checkpoints,
};

const outPath = fileURLToPath(
  new URL("../../shared/fixtures/idlist_vectors.json", import.meta.url),
);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath}`);
