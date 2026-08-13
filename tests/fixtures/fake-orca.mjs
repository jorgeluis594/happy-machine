#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
appendFileSync(
  path.join(cwd, ".fake-orca-calls.jsonl"),
  `${JSON.stringify(args)}\n`,
);
const operation = args.slice(0, 2).join(" ");
const terminalHandle = "terminal-1";

const jsonLabel = (text, label) => {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`${label}: `));
  if (!line) throw new Error(`missing developer instruction label ${label}`);
  return JSON.parse(line.slice(label.length + 2));
};

const numberLabel = (text, label) => {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`${label}: `));
  if (!line) throw new Error(`missing developer instruction label ${label}`);
  return Number(line.slice(label.length + 2));
};

const contractFromPrompt = (prompt) => {
  return {
    happyMachineAttemptIdentity: jsonLabel(prompt, "Attempt identity"),
    projectWorkspace: jsonLabel(prompt, "Project workspace"),
    contextPath: jsonLabel(prompt, "Context file"),
    attemptNumber: numberLabel(prompt, "Attempt number"),
    timeoutMs: numberLabel(prompt, "Timeout milliseconds"),
    outputDirectory: jsonLabel(prompt, "The assigned output directory is"),
    resultPath: jsonLabel(prompt, "Write the task result to exactly"),
    instructions: prompt,
  };
};

const generateResult = (contract) => {
  const stateId = contract.happyMachineAttemptIdentity.split(":")[1];
  const resultsFile = path.join(cwd, ".fake-results.json");
  const configured = existsSync(resultsFile)
    ? JSON.parse(readFileSync(resultsFile, "utf8"))[stateId]
    : undefined;
  const outcomeFile = path.join(cwd, ".fake-outcome");
  const outcome =
    configured?.outcome ??
    (existsSync(outcomeFile)
      ? readFileSync(outcomeFile, "utf8").trim()
      : "approved");
  const context = readFileSync(contract.contextPath, "utf8");
  writeFileSync(path.join(cwd, `.fake-context-${stateId}.md`), context);
  const durableLine = context
    .split("\n")
    .find((line) => line.startsWith("- Durable path: "));
  if (durableLine) {
    const durablePath = JSON.parse(
      durableLine.slice("- Durable path: ".length),
    );
    writeFileSync(
      path.join(cwd, ".fake-agent-input-content"),
      readFileSync(durablePath, "utf8"),
    );
  }
  const documents = (configured?.documents ?? []).map((document) => {
    const target = path.join(contract.outputDirectory, document.path);
    writeFileSync(target, document.content);
    return document.path;
  });
  for (const edit of configured?.workspaceEdits ?? [])
    writeFileSync(path.join(cwd, edit.path), edit.content);
  const rawResult = existsSync(path.join(cwd, ".fake-raw-result"))
    ? readFileSync(path.join(cwd, ".fake-raw-result"), "utf8")
    : `${JSON.stringify({
        outcome,
        documents,
        ...(configured?.error === undefined ? {} : { error: configured.error }),
      })}\n`;
  writeFileSync(contract.resultPath, rawResult);
};

const validatePreparedRun = () => {
  if (
    existsSync(path.join(cwd, ".fake-require-run-id-marker")) &&
    !existsSync(path.join(cwd, ".run-id-printed"))
  ) {
    process.stderr.write("run ID was not printed before Orca started\n");
    process.exit(3);
  }
  if (!existsSync(path.join(cwd, ".fake-require-snapshot-marker"))) return;
  const runId = readFileSync(path.join(cwd, ".run-id-printed"), "utf8").trim();
  const runDirectory = path.join(cwd, ".happy-machine", "runs", runId);
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
  const originalMarker = path.join(cwd, ".fake-original-input-path");
  if (existsSync(originalMarker)) {
    const originalPath = readFileSync(originalMarker, "utf8").trim();
    writeFileSync(originalPath, "content changed after run creation\n");
  }
};

const failureConfigPath = path.join(cwd, ".fake-orca-failures.json");
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
if (operation === "terminal create") {
  validatePreparedRun();
  const command = args[args.indexOf("--command") + 1];
  writeFileSync(path.join(cwd, ".fake-codex-command"), command);
  response = { terminal: { handle: terminalHandle } };
} else if (operation === "terminal send") {
  const handle = args[args.indexOf("--terminal") + 1];
  const prompt = args[args.indexOf("--text") + 1];
  writeFileSync(path.join(cwd, ".fake-prompt"), prompt);
  appendFileSync(
    path.join(cwd, ".fake-prompts.jsonl"),
    `${JSON.stringify(prompt)}\n`,
  );
  const contract = contractFromPrompt(prompt);
  const contractPath = path.join(cwd, ".fake-contract.json");
  writeFileSync(contractPath, JSON.stringify({ ...contract, prompt }));
  appendFileSync(
    path.join(cwd, ".fake-contracts.jsonl"),
    `${JSON.stringify(contract)}\n`,
  );
  const blocked =
    existsSync(path.join(cwd, ".fake-block-check")) &&
    !existsSync(path.join(cwd, ".fake-release-check"));
  if (!blocked) generateResult(contract);
  response = {
    send: {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt) + 1,
    },
  };
} else if (operation === "terminal show") {
  const handle = args[args.indexOf("--terminal") + 1];
  if (
    existsSync(path.join(cwd, ".fake-block-check")) &&
    !existsSync(path.join(cwd, ".fake-release-check"))
  )
    writeFileSync(path.join(cwd, ".fake-check-waiting"), "waiting\n");
  if (
    existsSync(path.join(cwd, ".fake-release-check")) &&
    existsSync(path.join(cwd, ".fake-contract.json"))
  ) {
    const contract = JSON.parse(
      readFileSync(path.join(cwd, ".fake-contract.json"), "utf8"),
    );
    if (!existsSync(contract.resultPath)) generateResult(contract);
  }
  const stateFile = [
    ".fake-terminal-state",
    ".fake-recovery-state",
    ".fake-worker-state",
  ]
    .map((name) => path.join(cwd, name))
    .find(existsSync);
  const state = stateFile ? readFileSync(stateFile, "utf8").trim() : "running";
  response = {
    terminal: {
      handle,
      connected:
        state === "running" || state === "ready" || state === "succeeded",
      writable: state === "running" || state === "ready",
      orphaned: state === "orphaned",
    },
  };
} else if (operation === "terminal read") {
  const handle = args[args.indexOf("--terminal") + 1];
  const cursorIndex = args.indexOf("--cursor");
  response = {
    terminal: {
      handle,
      status: "running",
      tail: cursorIndex < 0 ? ["agent progress", "match"] : [],
      nextCursor: cursorIndex < 0 ? "page-1" : "page-2",
    },
  };
} else if (operation === "terminal close") {
  const handle = args[args.indexOf("--terminal") + 1];
  writeFileSync(path.join(cwd, ".fake-terminal-state"), "stopped\n");
  response = {
    close: { handle, closeMode: args.includes("--tab") ? "tab" : "pane" },
  };
} else {
  process.stderr.write(`unexpected fake Orca operation: ${operation}\n`);
  process.exit(2);
}

const responseOverridesPath = path.join(
  cwd,
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
