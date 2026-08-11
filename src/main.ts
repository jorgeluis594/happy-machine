#!/usr/bin/env node
import { createProcessEntryPoint } from "./composition-root.js";

process.exitCode = await createProcessEntryPoint()(
  process.argv.slice(2),
  process.cwd(),
);
