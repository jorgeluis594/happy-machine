export class ControllerDetachedError extends Error {
  readonly code = "controller_detached";

  constructor() {
    super("Controller detached");
  }
}

export function throwIfDetached(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ControllerDetachedError();
}

export function detached(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectDetached = () => reject(new ControllerDetachedError());
    if (signal.aborted) rejectDetached();
    else signal.addEventListener("abort", rejectDetached, { once: true });
  });
}
