import type {
  JsonBindingDefinition,
  ParallelTaskDefinition,
  ParallelTaskWorkDefinition,
} from "../../ports/project-definitions.js";
import type {
  DynamicTaskBinding,
  JsonValue,
  ParallelTaskRecord,
  RunWorkspaceRecord,
} from "./run.js";

export interface ParallelTaskMaterializationInput {
  taskDefinitions: Readonly<Record<string, ParallelTaskDefinition>>;
  projectRoot: string;
  workspaceMode: RunWorkspaceRecord["mode"];
  dynamicSource?: DynamicTaskBinding["source"];
  workItems?: readonly JsonValue[];
}

/** Resolve the closed binding language once, producing a detached JSON value. */
export function resolveWorkflowBindings(
  bindings: Readonly<Record<string, JsonBindingDefinition>>,
  item?: JsonValue,
): Record<string, JsonValue> {
  const resolve = (value: JsonBindingDefinition): JsonValue => {
    if (value === "$item") {
      if (item === undefined)
        throw new Error("$item requires a dynamic work item");
      return structuredClone(item);
    }
    if (Array.isArray(value)) return value.map((entry) => resolve(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, resolve(entry)]),
      );
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(bindings).map(([key, value]) => [key, resolve(value)]),
  );
}

/**
 * The one construction rule for parallel queues. Callers must resolve and
 * validate dynamic output before invoking this function; this function only
 * creates durable records and clones bindings so later mutations cannot alter
 * the committed queue.
 */
export function materializeParallelTasks(
  input: ParallelTaskMaterializationInput,
): ParallelTaskRecord[] {
  const entries = input.dynamicSource
    ? (input.workItems ?? []).map((item) => {
        if (
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          typeof item.id !== "string"
        )
          throw new Error(
            "Committed work_items output contains an invalid item",
          );
        return [item.id, item] as const;
      })
    : Object.entries(input.taskDefinitions).map(
        ([id]) => [id, undefined] as const,
      );

  return entries.map(([id, item]) => ({
    id,
    status: "queued" as const,
    attempts: [],
    documents: [],
    ...(item === undefined
      ? {}
      : {
          dynamic: {
            workItem: structuredClone(item),
            source: input.dynamicSource!,
          },
        }),
    workspace:
      input.workspaceMode === "worktree"
        ? { mode: "worktree" as const, path: "" }
        : { mode: "direct" as const, path: input.projectRoot },
  }));
}

export function agentParallelWork(
  taskDefinition: ParallelTaskWorkDefinition,
): Extract<ParallelTaskWorkDefinition, { type: "agent" }> {
  if (taskDefinition.type !== "agent")
    throw new Error("Workflow parallel tasks are not executable yet");
  return taskDefinition;
}
