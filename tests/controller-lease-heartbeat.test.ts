import { describe, expect, it } from "vitest";
import { ControllerLeaseHeartbeat } from "../src/application/services/controller-lease-heartbeat.js";
import { ControllerDetachedError } from "../src/application/services/controller-detachment.js";
import type { RunRecord } from "../src/domain/execution/run.js";
import {
  ControllerLeaseLostError,
  type RunRepository,
} from "../src/ports/run-repository.js";

class ControlledClock {
  private milliseconds = Date.parse("2026-09-01T00:00:00.000Z");
  private waits: Array<{ due: number; resolve: () => void }> = [];

  now = (): Date => new Date(this.milliseconds);

  wait = (delay: number): Promise<void> =>
    new Promise((resolve) => {
      this.waits.push({ due: this.milliseconds + delay, resolve });
    });

  advance(delay: number): void {
    this.milliseconds += delay;
    const ready = this.waits.filter((item) => item.due <= this.milliseconds);
    this.waits = this.waits.filter((item) => item.due > this.milliseconds);
    for (const item of ready) item.resolve();
  }
}

function run(clock: ControlledClock): RunRecord {
  return {
    id: "run-heartbeat",
    workflowId: "workflow",
    workflowPath: "workflow.md",
    projectRoot: "/project",
    status: "running",
    controllerStatus: "attached",
    controllerLease: {
      controllerId: "controller-one",
      fencingToken: 7,
      acquiredAt: clock.now().toISOString(),
      renewedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 100).toISOString(),
      durationMs: 100,
    },
    createdAt: clock.now().toISOString(),
    deadlineAt: new Date(clock.now().getTime() + 10_000).toISOString(),
    transitionCount: 0,
    visits: [],
    documents: [],
    events: [],
  } as unknown as RunRecord;
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("controller lease heartbeat", () => {
  it("renews repeatedly with the same identity without replacing mutable state", async () => {
    const clock = new ControlledClock();
    const controlled = run(clock);
    const calls: Array<{ controllerId: string; fencingToken: number }> = [];
    const repository = {
      renewControl: (
        durable: RunRecord,
        controllerId: string,
        fencingToken: number,
        observedAt: string,
      ) => {
        calls.push({ controllerId, fencingToken });
        const renewed = structuredClone(durable);
        renewed.controllerLease!.expiresAt = new Date(
          Date.parse(observedAt) + 100,
        ).toISOString();
        renewed.events.push({
          sequence: renewed.events.length + 1,
          type: "controller_lease_renewed",
          at: observedAt,
          data: { controllerId, fencingToken },
        });
        return Promise.resolve({ run: renewed, fencingToken });
      },
    } as unknown as RunRepository;
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => (finish = resolve));
    const active = new ControllerLeaseHeartbeat(
      repository,
      clock.now,
      clock.wait,
    ).run(
      {
        getRun: () => controlled,
        controllerId: "controller-one",
        fencingToken: 7,
      },
      () => operation,
    );

    controlled.events.push({
      sequence: 1,
      type: "task_started",
      at: clock.now().toISOString(),
      data: {},
    });
    for (let index = 0; index < 3; index++) {
      clock.advance(49);
      await turn();
    }
    finish();
    await active;

    expect(calls).toEqual([
      { controllerId: "controller-one", fencingToken: 7 },
      { controllerId: "controller-one", fencingToken: 7 },
      { controllerId: "controller-one", fencingToken: 7 },
    ]);
    expect(controlled.events.map((event) => event.type)).toEqual([
      "task_started",
      "controller_lease_renewed",
      "controller_lease_renewed",
      "controller_lease_renewed",
    ]);
  });

  it("reports fencing loss without canceling the external operation", async () => {
    const clock = new ControlledClock();
    const controlled = run(clock);
    const externalCanceled = false;
    const repository = {
      renewControl: () =>
        Promise.reject(new ControllerLeaseLostError("stale fencing token")),
    } as unknown as RunRepository;
    const active = new ControllerLeaseHeartbeat(
      repository,
      clock.now,
      clock.wait,
    ).run(
      {
        getRun: () => controlled,
        controllerId: "controller-one",
        fencingToken: 7,
      },
      () => new Promise<void>(() => undefined),
    );

    clock.advance(49);
    await expect(active).rejects.toBeInstanceOf(ControllerLeaseLostError);
    expect(externalCanceled).toBe(false);
  });

  it("stops before detachment returns and never renews late", async () => {
    const clock = new ControlledClock();
    const controlled = run(clock);
    const signal = new AbortController();
    let renewals = 0;
    const repository = {
      renewControl: () => {
        renewals += 1;
        return Promise.resolve({ run: controlled, fencingToken: 7 });
      },
    } as unknown as RunRepository;
    const active = new ControllerLeaseHeartbeat(
      repository,
      clock.now,
      clock.wait,
    ).run(
      {
        getRun: () => controlled,
        controllerId: "controller-one",
        fencingToken: 7,
        signal: signal.signal,
      },
      () => new Promise<void>(() => undefined),
    );

    signal.abort();
    await expect(active).rejects.toBeInstanceOf(ControllerDetachedError);
    clock.advance(500);
    await turn();
    expect(renewals).toBe(0);
  });
});
