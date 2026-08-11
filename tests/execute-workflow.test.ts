import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExecuteWorkflow } from '../src/application/use-cases/execute-workflow.js';
import { Cli } from '../src/infrastructure/inbound/cli/cli.js';
import { FilesystemProjectDefinitions } from '../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js';
import { FilesystemRunRepository } from '../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js';
import { OrcaTaskExecutor } from '../src/infrastructure/outbound/task-executor/orca/orca-task-executor.js';

const fixture = path.resolve('tests/fixtures/fake-orca.mjs');
const temporaryDirectories: string[] = [];

beforeAll(async () => chmod(fixture, 0o755));
afterEach(() => { temporaryDirectories.length = 0; });

async function project(outcome: 'approved' | 'rejected' = 'approved', explicitDefaults = false): Promise<{ root: string; workflow: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'happy-machine-test-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'agents'));
  await mkdir(path.join(root, 'workflows'));
  await writeFile(path.join(root, 'agents', 'worker.md'), '# Worker\nFollow the task.\n');
  await writeFile(path.join(root, 'happy-machine.yaml'), [
    'version: 1',
    ...(explicitDefaults ? ['executor:', '  type: orca', 'workspace:', '  mode: direct'] : []),
    'agents:', '  worker:', '    instructions: agents/worker.md', '    model: test-model',
    'defaults:', '  attempt_timeout: 5s', '',
  ].join('\n'));
  const workflow = path.join(root, 'workflows', 'one.yaml');
  await writeFile(workflow, [
    'version: 1', 'id: one-state', 'initial_state: review', 'states:', '  review:', '    type: agent',
    '    agent: worker', '    prompt: Choose an outcome and write the structured result.', '    outcomes:',
    '      approved: $succeeded', '      rejected: $failed', '',
  ].join('\n'));
  await writeFile(path.join(root, '.fake-outcome'), outcome);
  await writeFile(path.join(root, '.fake-require-run-id-marker'), 'required');
  return { root, workflow };
}

function cli(projectRoot?: string) {
  let id = 0;
  const useCase = new ExecuteWorkflow(
    new FilesystemProjectDefinitions(), new FilesystemRunRepository(), new OrcaTaskExecutor(fixture),
    () => new Date('2026-08-11T12:00:00.000Z'), () => `id-${++id}`,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cli: new Cli(useCase, {
      stdout: (line) => {
        stdout.push(line);
        if (projectRoot && line.startsWith('run_')) writeFileSync(path.join(projectRoot, '.run-id-printed'), line);
      },
      stderr: (line) => stderr.push(line),
    }), stdout, stderr,
  };
}

async function storedRun(root: string) {
  const runId = (await import('node:fs/promises')).readdir(path.join(root, '.happy-machine', 'runs')).then((ids) => ids[0]!);
  return JSON.parse(await readFile(path.join(root, '.happy-machine', 'runs', await runId, 'run.json'), 'utf8'));
}

describe('happy-machine execute', () => {
  it.each([false, true])('discovers and executes from the project root (explicit defaults: %s)', async (explicitDefaults) => {
    const setup = await project('approved', explicitDefaults);
    const app = cli(setup.root);
    const exit = await app.cli.run(['execute', path.relative(setup.root, setup.workflow)], setup.root);
    expect(exit).toBe(0);
    expect(app.stdout).toEqual(['run_id-1', 'Run run_id-1: succeeded']);
  });

  it('discovers the nearest project from a nested directory and resolves paths from its root', async () => {
    const setup = await project();
    const nested = path.join(setup.root, 'deep', 'inside');
    await mkdir(nested, { recursive: true });
    const app = cli(setup.root);
    expect(await app.cli.run(['execute', path.relative(nested, setup.workflow)], nested)).toBe(0);
    const run = await storedRun(setup.root);
    expect(run.projectRoot).toBe(setup.root);
    expect(run.workflowPath).toBe(setup.workflow);
  });

  it('fails before allocating a run or invoking Orca when no project exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'happy-machine-missing-'));
    const app = cli();
    expect(await app.cli.run(['execute', 'workflow.yaml'], root)).toBe(1);
    expect(app.stdout).toEqual([]);
    await expect(readFile(path.join(root, '.fake-orca-calls.jsonl'))).rejects.toThrow();
    await expect(readFile(path.join(root, '.happy-machine', 'runs'))).rejects.toThrow();
  });

  it.each([['approved', 0, 'succeeded', '$succeeded'], ['rejected', 1, 'failed', '$failed']] as const)(
    'routes structured outcome %s to the declared terminal', async (outcome, expectedExit, status, target) => {
      const setup = await project(outcome);
      const app = cli(setup.root);
      expect(await app.cli.run(['execute', setup.workflow], setup.root)).toBe(expectedExit);
      const run = await storedRun(setup.root);
      expect(run.status).toBe(status);
      expect(run.terminalTarget).toBe(target);
      expect(run.visits[0].outcome).toBe(outcome);
    },
  );

  it('uses only result.json for routing and durably attributes the launch, logs, and outcome', async () => {
    const setup = await project('approved');
    const app = cli(setup.root);
    expect(await app.cli.run(['execute', setup.workflow], setup.root)).toBe(0);
    const run = await storedRun(setup.root);
    const attempt = run.visits[0].task.attempts[0];
    expect(run.visits[0]).toMatchObject({ stateId: 'review', number: 1, task: { id: 'review-task' } });
    expect(attempt).toMatchObject({
      id: 'run_id-1:review:1:review-task:1', number: 1, status: 'succeeded', outcome: 'approved',
      executor: { runId: 'orca-run-1', taskId: 'orca-task-1', dispatchId: 'orca-dispatch-1', terminalHandle: 'terminal-1' },
    });
    expect(attempt.logs.stdout).toContain('misleading stdout outcome: rejected');
    expect(attempt.logs.stderr).toContain('misleading stderr outcome: rejected');
    expect(run.events.map((event: { type: string }) => event.type)).toEqual([
      'run_created', 'state_entered', 'attempt_launching', 'attempt_started', 'attempt_succeeded', 'run_terminal',
    ]);
    const contract = JSON.parse(await readFile(path.join(setup.root, '.fake-contract.json'), 'utf8'));
    expect(contract).toMatchObject({
      happyMachineAttemptIdentity: attempt.id, projectWorkspace: setup.root, contextPath: attempt.contextPath,
      outputDirectory: attempt.outputDirectory, resultPath: attempt.resultPath, model: 'test-model', timeoutMs: 5000, attemptNumber: 1,
    });
    expect(contract.instructions).toContain('Follow the task');
    expect(contract.prompt).toContain('Choose an outcome');
  });
});
