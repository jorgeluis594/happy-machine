export type ExclusiveOperationName = "create-skill";

export interface OperationLease {
  id: string;
}

export class ExclusiveOperationAlreadyActiveError extends Error {
  override readonly name = "ExclusiveOperationAlreadyActiveError";

  constructor(readonly operation: ExclusiveOperationName) {
    super(`The exclusive operation is already active: ${operation}`);
  }
}

export interface ExclusiveOperationLock {
  acquire(name: ExclusiveOperationName): Promise<OperationLease>;
  release(lease: OperationLease): Promise<void>;
}
