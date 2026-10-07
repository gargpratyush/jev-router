#!/usr/bin/env node
import { readStatus } from "../src/lib/status.mjs";
import { formatExplanation } from "../src/lib/explain.mjs";

process.stdout.write(`${formatExplanation(readStatus(process.argv[2] ?? process.env.JEV_CODEX_STATUS_ID))}\n`);
