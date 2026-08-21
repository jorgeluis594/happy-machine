export type ExclusiveOperationName = "create-skill";

export interface OperationLease {
  id: string;
}

export interface ExclusiveOperationLock {
  acquire(name: ExclusiveOperationName): Promise<OperationLease>;
  release(lease: OperationLease): Promise<void>;
}
