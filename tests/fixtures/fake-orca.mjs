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
  response = { run: { runId: "orca-run-1" } };
} else if (operation === "orchestration task-create") {
  const spec = args[args.indexOf("--spec") + 1];
  writeFileSync(path.join(process.cwd(), ".fake-contract.json"), spec);
  appendFileSync(
    path.join(process.cwd(), ".fake-contracts.jsonl"),
    `${spec}\n`,
  );
  response = { task: { taskId: "orca-task-1" } };
} else if (operation === "orchestration task-list") {
  const identityFile = path.join(process.cwd(), ".fake-recovery-identity");
  response = {
    tasks: existsSync(identityFile)
      ? [
          {
            taskId: "recovered-task",
            spec: {
              happyMachineAttemptIdentity: readFileSync(
                identityFile,
                "utf8",
              ).trim(),
            },
          },
        ]
      : [],
  };
} else if (operation === "orchestration dispatch-show") {
  const stateFile = path.join(process.cwd(), ".fake-recovery-state");
  response = {
    dispatch: {
      taskId: "recovered-task",
      dispatchId: "recovered-dispatch",
      agentTerminalHandle: "recovered-terminal",
      workerState: existsSync(stateFile)
        ? readFileSync(stateFile, "utf8").trim()
        : "ready",
    },
  };
} else if (operation === "orchestration worker-start") {
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
    dispatch: { dispatchId: "orca-dispatch-1" },
    worker: { agentTerminalHandle: "terminal-1" },
  };
} else if (operation === "orchestration check") {
  if (existsSync(path.join(process.cwd(), ".fake-block-check"))) {
    writeFileSync(path.join(process.cwd(), ".fake-check-waiting"), "waiting\n");
    while (!existsSync(path.join(process.cwd(), ".fake-release-check")))
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.stderr.write("misleading stderr outcome: rejected\n");
  response = {
    messages: [
      {
        type: "worker_done",
        outcome: "succeeded",
        dispatchId: "orca-dispatch-1",
      },
    ],
    log: "misleading stdout outcome: rejected",
  };
} else if (operation === "orchestration worker-stop") {
  response = { dispatch: { state: "stopping" } };
} else if (operation === "orchestration worker-show") {
  const stateFile = path.join(process.cwd(), ".fake-worker-state");
  response = {
    dispatch: {
      workerState: existsSync(stateFile)
        ? readFileSync(stateFile, "utf8").trim()
        : "stopped",
    },
  };
} else {
  process.stderr.write(`unexpected fake Orca operation: ${operation}\n`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(response)}\n`);
