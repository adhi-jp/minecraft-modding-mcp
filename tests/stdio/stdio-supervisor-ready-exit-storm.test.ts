import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { MIN_HEALTHY_WORKER_READY_MS, StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * A host may hand every spawned child a stdin that closes immediately — the
 * shape `probeNativeStdioPipes` in tests/helpers/runtime-capabilities.ts exists
 * to detect. On such a host the worker observes EOF while it is still starting,
 * writes its ready marker, and then stands down at once with exit code 0.
 *
 * That is a CLEAN, voluntary stand-down of an already-adopted generation, and
 * adoption clears the restart backoff. Without the escalation these tests pin,
 * the supervisor answers every stand-down with the 100 ms floor and respawns a
 * ~125 MB worker ten times a second for as long as the process lives.
 *
 * A generation that CRASHES right after adoption is a different case and keeps
 * the prompt 100 ms replacement (pinned by stdio-supervisor-state.test.ts):
 * a crash may well be transient, whereas a clean stand-down means the host
 * closed the pipe and will close the replacement's pipe the same way.
 */

const WORKER_READY_MARKER = "__MCP_STDIO_WORKER_READY__\n";

type VirtualTimer = NodeJS.Timeout & {
  at: number;
  callback: () => void;
  cleared: boolean;
  fired: boolean;
};

type StormChild = EventEmitter & {
  pid: number;
  stdin: EventEmitter & { destroyed: boolean; write(payload: string): boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(): boolean;
};

type Harness = {
  spawnWorker(): void;
  currentRetryReservation?: { epoch: number; notBefore: number; delayMs: number };
};

function createStormChild(pid: number): StormChild {
  const stdin = new EventEmitter() as StormChild["stdin"];
  stdin.destroyed = false;
  stdin.write = () => true;
  const child = new EventEmitter() as StormChild;
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

/** Lets queued child events (ready marker, exit) reach the supervisor. */
async function settleChildEvents(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type StormRig = {
  supervisor: Harness;
  spawns(): number;
  /** Virtual-clock ms at which each spawn happened. */
  spawnTimes(): number[];
  now(): number;
  setNow(value: number): void;
  /** Fires every due virtual timer up to `limit`, oldest first. */
  advanceTo(limit: number): Promise<void>;
};

/**
 * `behaviour` decides what each spawned child does once the supervisor has
 * attached its listeners: emit the ready marker, then exit however the case
 * under test needs.
 */
function createStormRig(
  behaviour: (child: StormChild, rig: () => StormRig) => void
): StormRig {
  let now = 0;
  const timers: VirtualTimer[] = [];
  const spawnTimes: number[] = [];
  let nextPid = 900_000;

  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: () => {},
    eventWriter: () => {},
    validateProjectTimeoutMs: 10_000,
    monotonicNow: () => now,
    timerScheduler: (callback: () => void, delayMs: number) => {
      const timer = {
        at: now + delayMs,
        callback,
        cleared: false,
        fired: false,
        unref() { return this; }
      } as unknown as VirtualTimer;
      timers.push(timer);
      return timer;
    },
    timerClearer: (timer: NodeJS.Timeout) => { (timer as VirtualTimer).cleared = true; },
    workerSpawner: () => {
      const child = createStormChild(++nextPid);
      spawnTimes.push(now);
      setImmediate(() => behaviour(child, () => rig));
      return child as never;
    }
  } as never) as unknown as Harness;

  const rig: StormRig = {
    supervisor,
    spawns: () => spawnTimes.length,
    spawnTimes: () => [...spawnTimes],
    now: () => now,
    setNow: (value: number) => { now = value; },
    async advanceTo(limit: number): Promise<void> {
      for (let guard = 0; guard < 2_000; guard += 1) {
        await settleChildEvents();
        const due = timers
          .filter((timer) => !timer.cleared && !timer.fired && timer.at <= limit)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) return;
        now = Math.max(now, due.at);
        due.fired = true;
        due.callback();
      }
      throw new Error("virtual timer loop did not settle");
    }
  };
  return rig;
}

/** Ready marker, then a clean voluntary stand-down in the same instant. */
function readyThenCleanExit(child: StormChild): void {
  child.stderr.emit("data", Buffer.from(WORKER_READY_MARKER));
  setImmediate(() => child.emit("exit", 0, null));
}

test("a worker that stands down cleanly right after signalling ready cannot respawn at the backoff floor forever", async () => {
  const rig = createStormRig((child) => readyThenCleanExit(child));
  rig.supervisor.spawnWorker();
  await rig.advanceTo(3_000);

  // The floor is 100 ms, so an unescalated loop fits ~31 spawns into this
  // window. Escalation puts the 6th spawn beyond it (0, 200, 600, 1400, 3000).
  assert.ok(
    rig.spawns() <= 8,
    `bounded respawn expected over 3000 virtual ms, saw ${rig.spawns()} spawns at ${rig.spawnTimes().join(", ")}`
  );
  assert.ok(rig.spawns() >= 2, "the supervisor must still replace a stood-down worker at least once");

  // The gaps must GROW: a fixed small gap is the runaway loop with a smaller
  // constant, not a bounded one.
  const gaps = rig.spawnTimes().slice(1).map((at, index) => at - rig.spawnTimes()[index]);
  for (const [index, gap] of gaps.slice(1).entries()) {
    assert.ok(
      gap > gaps[index],
      `restart gaps must grow, saw ${gaps.join(", ")}`
    );
  }
});

test("a worker that stayed ready long enough keeps the prompt restart floor when it stands down", async () => {
  const rig = createStormRig((child, self) => {
    child.stderr.emit("data", Buffer.from(WORKER_READY_MARKER));
    setImmediate(() => {
      // Serve past the healthy-generation threshold before standing down.
      self().setNow(self().now() + MIN_HEALTHY_WORKER_READY_MS + 1);
      child.emit("exit", 0, null);
    });
  });
  rig.supervisor.spawnWorker();
  await rig.advanceTo(10_000);

  assert.equal(
    rig.supervisor.currentRetryReservation?.delayMs,
    100,
    "a generation that actually served must be replaced at the prompt floor"
  );
  const gaps = rig.spawnTimes().slice(1).map((at, index) => at - rig.spawnTimes()[index]);
  for (const gap of gaps) {
    assert.equal(gap, MIN_HEALTHY_WORKER_READY_MS + 1 + 100, `saw gaps ${gaps.join(", ")}`);
  }
});
