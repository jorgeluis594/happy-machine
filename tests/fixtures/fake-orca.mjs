#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
appendFileSync(
  path.join(process.cwd(), ".fake-orca-calls.jsonl"),
  `${JSON.stringify(args)}\n`,
);
const operation = args.slice(0, 2).join(" ");
const failureConfigPath = path.join(process.cwd(), ".fake-orca-failures.json");
if (existsSync(failureConfigPath)) {
  const failure = JSON.parse(readFileSync(failureConfigPath, "utf8"))[
    operation
  ];
  if (failure) {
    if (failure.stderr) process.stderr.write(failure.stderr);
    const stdout =
      failure.stdout ??
      JSON.stringify({
        id: `rpc-${operation.replaceAll(" ", "-")}-failure`,
        ok: false,
        error: failure.error ?? {
          code: "fake_orca_failure",
          message: `Configured failure for ${operation}`,
        },
        _meta: { runtimeId: "fake-runtime" },
      });
    await new Promise((resolve) =>
      process.stdout.write(`${stdout}\n`, resolve),
    );
    process.exit(failure.exitCode ?? 1);
  }
}
let response;
if (operation === "orchestration run-create") {
  if (
    existsSync(path.join(process.cwd(), ".fake-require-run-id-marker")) &&
    !existsSync(path.join(process.cwd(), ".run-id-printed"))
  ) {
    process.stderr.write("run ID was not printed before Orca started\n");
    process.exit(3);
  }
  if (existsSync(path.join(process.cwd(), ".fake-require-snapshot-marker"))) {
    const runId = readFileSync(
      path.join(process.cwd(), ".run-id-printed"),
      "utf8",
    ).trim();
    const runDirectory = path.join(
      process.cwd(),
      ".happy-machine",
      "runs",
      runId,
    );
    const run = JSON.parse(
      readFileSync(path.join(runDirectory, "run.json"), "utf8"),
    );
    const attempt = run.visits[0].task.attempts[0];
    const requiredPaths = [
      run.definitionSnapshot.manifestPath,
      run.visits[0].contextPath,
      attempt.contextPath,
      attempt.outputDirectory,
      path.dirname(attempt.resultPath),
    ];
    const manifest = JSON.parse(
      readFileSync(run.definitionSnapshot.manifestPath, "utf8"),
    );
    for (const artifact of manifest.artifacts)
      requiredPaths.push(
        path.join(
          run.definitionSnapshot.directory,
          ...artifact.internalPath.split("/"),
        ),
      );
    if (requiredPaths.some((requiredPath) => !existsSync(requiredPath))) {
      process.stderr.write("snapshot or control path missing before Orca\n");
      process.exit(4);
    }
    const originalMarker = path.join(
      process.cwd(),
      ".fake-original-input-path",
    );
    if (existsSync(originalMarker)) {
      const originalPath = readFileSync(originalMarker, "utf8").trim();
      writeFileSync(originalPath, "content changed after run creation\n");
    }
  }
  response = { run: { id: "orca-run-1" } };
} else if (operation === "orchestration task-create") {
  const spec = args[args.indexOf("--spec") + 1];
  writeFileSync(path.join(process.cwd(), ".fake-contract.json"), spec);
  appendFileSync(
    path.join(process.cwd(), ".fake-contracts.jsonl"),
    `${spec}\n`,
  );
  response = { task: { id: "orca-task-1" } };
} else if (operation === "orchestration task-list") {
  const identityFile = path.join(process.cwd(), ".fake-recovery-identity");
  const tasks = existsSync(identityFile)
    ? [
        {
          id: "recovered-task",
          spec: JSON.stringify({
            happyMachineAttemptIdentity: readFileSync(
              identityFile,
              "utf8",
            ).trim(),
          }),
        },
      ]
    : [];
  response = {
    runId: "orca-run-1",
    legacyReadOnly: false,
    tasks,
    count: tasks.length,
  };
} else if (operation === "orchestration dispatch-show") {
  const stateFile = path.join(process.cwd(), ".fake-recovery-state");
  const dispatchFile = path.join(process.cwd(), ".fake-started-dispatch-id");
  const taskId = args[args.indexOf("--task") + 1];
  response = {
    dispatch: {
      id: existsSync(dispatchFile)
        ? readFileSync(dispatchFile, "utf8").trim()
        : "recovered-dispatch",
      task_id: taskId,
      agent_terminal_handle: existsSync(dispatchFile)
        ? "terminal-1"
        : "recovered-terminal",
      worker_state: existsSync(stateFile)
        ? readFileSync(stateFile, "utf8").trim()
        : "ready",
    },
  };
} else if (operation === "terminal create") {
  response = { terminal: { handle: "terminal-1" } };
} else if (operation === "orchestration dispatch") {
  const taskId = args[args.indexOf("--task") + 1];
  const dispatchId = "orca-dispatch-1";
  writeFileSync(path.join(process.cwd(), ".fake-started-task-id"), taskId);
  writeFileSync(
    path.join(process.cwd(), ".fake-started-dispatch-id"),
    dispatchId,
  );
  const contract = JSON.parse(
    readFileSync(path.join(process.cwd(), ".fake-contract.json"), "utf8"),
  );
  const stateId = contract.happyMachineAttemptIdentity.split(":")[1];
  const resultsFile = path.join(process.cwd(), ".fake-results.json");
  const configured = existsSync(resultsFile)
    ? JSON.parse(readFileSync(resultsFile, "utf8"))[stateId]
    : undefined;
  const outcomeFile = path.join(process.cwd(), ".fake-outcome");
  const outcome =
    configured?.outcome ??
    (existsSync(outcomeFile)
      ? readFileSync(outcomeFile, "utf8").trim()
      : "approved");
  const context = readFileSync(contract.contextPath, "utf8");
  writeFileSync(
    path.join(process.cwd(), `.fake-context-${stateId}.md`),
    context,
  );
  const durableLine = context
    .split("\n")
    .find((line) => line.startsWith("- Durable path: "));
  if (durableLine) {
    const durablePath = JSON.parse(
      durableLine.slice("- Durable path: ".length),
    );
    writeFileSync(
      path.join(process.cwd(), ".fake-agent-input-content"),
      readFileSync(durablePath, "utf8"),
    );
  }
  const documents = (configured?.documents ?? []).map((document) => {
    const target = path.join(contract.outputDirectory, document.path);
    writeFileSync(target, document.content);
    return document.path;
  });
  for (const edit of configured?.workspaceEdits ?? [])
    writeFileSync(path.join(process.cwd(), edit.path), edit.content);
  writeFileSync(
    contract.resultPath,
    `${JSON.stringify({
      outcome,
      documents,
      ...(configured?.error === undefined ? {} : { error: configured.error }),
    })}\n`,
  );
  response = {
    dispatch: {
      task_id: taskId,
      id: dispatchId,
      status: "active",
    },
  };
} else if (operation === "terminal close") {
  response = {
    terminal: { handle: args[args.indexOf("--terminal") + 1] },
    closed: true,
  };
} else if (operation === "orchestration check") {
  if (existsSync(path.join(process.cwd(), ".fake-block-check"))) {
    writeFileSync(path.join(process.cwd(), ".fake-check-waiting"), "waiting\n");
    while (!existsSync(path.join(process.cwd(), ".fake-release-check")))
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const sequenceFile = path.join(process.cwd(), ".fake-check-sequence.json");
  if (existsSync(sequenceFile)) {
    const sequence = JSON.parse(readFileSync(sequenceFile, "utf8"));
    const indexFile = path.join(process.cwd(), ".fake-check-index");
    const index = existsSync(indexFile)
      ? Number(readFileSync(indexFile, "utf8"))
      : 0;
    writeFileSync(indexFile, String(index + 1));
    response = sequence[Math.min(index, sequence.length - 1)];
  } else {
    process.stderr.write("misleading stderr outcome: rejected\n");
    const dispatchFile = path.join(process.cwd(), ".fake-started-dispatch-id");
    const dispatchId = existsSync(dispatchFile)
      ? readFileSync(dispatchFile, "utf8").trim()
      : "orca-dispatch-1";
    response = {
      messages: [
        {
          id: "message-worker-done-1",
          type: "worker_done",
          subject: "completed",
          body: "worker completed",
          payload: JSON.stringify({ outcome: "succeeded", dispatchId }),
        },
      ],
      count: 1,
      log: "misleading stdout outcome: rejected",
    };
  }
} else if (operation === "orchestration worker-stop") {
  response = {
    dispatchId: args[args.indexOf("--dispatch") + 1],
    state: "stopping",
  };
} else if (operation === "orchestration worker-read") {
  const cursorIndex = args.indexOf("--cursor");
  response = {
    source: "transcript",
    cursor: cursorIndex < 0 ? "page-1" : "page-2",
    transcript: {
      messages:
        cursorIndex < 0
          ? [
              {
                role: "system",
                blocks: [{ type: "text", text: "hidden system prompt" }],
              },
              {
                role: "user",
                blocks: [{ type: "text", text: "hidden user prompt" }],
              },
              {
                role: "assistant",
                blocks: [
                  { type: "text", text: "agent progress" },
                  {
                    type: "tool-call",
                    name: "rg",
                    input: { pattern: "needle" },
                  },
                  { type: "tool-result", output: "match", isError: false },
                ],
              },
            ]
          : [],
    },
  };
} else if (operation === "orchestration worker-show") {
  const stateFile = path.join(process.cwd(), ".fake-worker-state");
  const taskFile = path.join(process.cwd(), ".fake-started-task-id");
  const dispatchId = args[args.indexOf("--dispatch") + 1];
  response = {
    dispatch: {
      id: dispatchId,
      task_id: existsSync(taskFile)
        ? readFileSync(taskFile, "utf8").trim()
        : "task",
    },
    worker: {
      state: existsSync(stateFile)
        ? readFileSync(stateFile, "utf8").trim()
        : "stopped",
      agent_terminal_handle: "terminal-1",
    },
  };
} else {
  process.stderr.write(`unexpected fake Orca operation: ${operation}\n`);
  process.exit(2);
}
const responseOverridesPath = path.join(
  process.cwd(),
  ".fake-orca-response-overrides.json",
);
const override = existsSync(responseOverridesPath)
  ? JSON.parse(readFileSync(responseOverridesPath, "utf8"))[operation]
  : undefined;
const envelope = override ?? {
  id: `rpc-${operation.replaceAll(" ", "-")}`,
  ok: true,
  result: response,
  _meta: { runtimeId: "fake-runtime" },
};
process.stdout.write(`${JSON.stringify(envelope)}\n`);
