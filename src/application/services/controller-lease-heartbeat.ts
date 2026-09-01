import type { RunRecord } from "../../domain/execution/run.js";
import {
  ControllerLeaseLostError,
  type RunRepository,
} from "../../ports/run-repository.js";
import { detached } from "./controller-detachment.js";

export type ControllerHeartbeatWait = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface ControlledLease {
  getRun(): RunRecord;
  controllerId: string;
  fencingToken: number;
  signal?: AbortSignal;
}

/** Keeps a controller lease alive independently of the work it supervises. */
export class ControllerLeaseHeartbeat {
  constructor(
    private readonly runs: RunRepository,
    private readonly now: () => Date,
    private readonly wait?: ControllerHeartbeatWait,
  ) {}

  async run<T>(
    control: ControlledLease,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      !this.wait ||
      !this.runs.renewControl ||
      !control.getRun().controllerLease
    )
      return operation();

    const stopped = new AbortController();
    const heartbeat = this.heartbeat(control, stopped.signal);
    const work = operation();
    // A lost lease detaches the controller immediately. The supervised external
    // work is deliberately not canceled; fencing prevents its controller from
    // committing anything after ownership has changed.
    work.catch(() => undefined);

    try {
      return await Promise.race([
        work,
        heartbeat,
        ...(control.signal ? [detached(control.signal)] : []),
      ]);
    } finally {
      stopped.abort();
      await heartbeat.catch(() => undefined);
    }
  }

  private async heartbeat(
    control: ControlledLease,
    stopped: AbortSignal,
  ): Promise<never> {
    while (true) {
      const durationMs = control.getRun().controllerLease?.durationMs;
      if (durationMs === undefined)
        throw new ControllerLeaseLostError("Controller lease is unavailable");
      const delay = Math.max(1, Math.floor((durationMs - 1) / 2));
      const renewAt = this.now().getTime() + delay;
      await Promise.race([this.wait!(delay), detached(stopped)]);
      // Some use-case tests inject a no-op wait. It must not turn the
      // independent loop into a busy microtask spinner when time did not pass.
      if (this.now().getTime() < renewAt) await detached(stopped);
      const renewed = await this.runs.renewControl!(
        control.getRun(),
        control.controllerId,
        control.fencingToken,
        this.now().toISOString(),
      );
      this.mergeRenewal(control.getRun(), renewed.run);
    }
  }

  private mergeRenewal(target: RunRecord, durable: RunRecord): void {
    target.controllerLease = durable.controllerLease;
    for (const event of durable.events) {
      if (event.type !== "controller_lease_renewed") continue;
      const duplicate = target.events.some(
        (candidate) =>
          candidate.type === event.type &&
          candidate.at === event.at &&
          JSON.stringify(candidate.data) === JSON.stringify(event.data),
      );
      if (!duplicate)
        target.events.push({ ...event, sequence: target.events.length + 1 });
    }
  }
}
