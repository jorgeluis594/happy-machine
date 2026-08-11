#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
appendFileSync(path.join(process.cwd(), '.fake-orca-calls.jsonl'), `${JSON.stringify(args)}\n`);
const operation = args.slice(0, 2).join(' ');
let response;
if (operation === 'orchestration run-create') {
  if (existsSync(path.join(process.cwd(), '.fake-require-run-id-marker')) && !existsSync(path.join(process.cwd(), '.run-id-printed'))) {
    process.stderr.write('run ID was not printed before Orca started\n');
    process.exit(3);
  }
  response = { run: { runId: 'orca-run-1' } };
} else if (operation === 'orchestration task-create') {
  const spec = args[args.indexOf('--spec') + 1];
  writeFileSync(path.join(process.cwd(), '.fake-contract.json'), spec);
  response = { task: { taskId: 'orca-task-1' } };
} else if (operation === 'orchestration worker-start') {
  const contract = JSON.parse(readFileSync(path.join(process.cwd(), '.fake-contract.json'), 'utf8'));
  const outcomeFile = path.join(process.cwd(), '.fake-outcome');
  const outcome = existsSync(outcomeFile) ? readFileSync(outcomeFile, 'utf8').trim() : 'approved';
  writeFileSync(contract.resultPath, `${JSON.stringify({ outcome, documents: [] })}\n`);
  response = { dispatch: { dispatchId: 'orca-dispatch-1' }, worker: { agentTerminalHandle: 'terminal-1' } };
} else if (operation === 'orchestration check') {
  process.stderr.write('misleading stderr outcome: rejected\n');
  response = { messages: [{ type: 'worker_done', outcome: 'succeeded', dispatchId: 'orca-dispatch-1' }], log: 'misleading stdout outcome: rejected' };
} else {
  process.stderr.write(`unexpected fake Orca operation: ${operation}\n`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(response)}\n`);
