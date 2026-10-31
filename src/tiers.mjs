import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { TIER_NAMES, availableTiers, parseTierList, savedTiersFile } from "./config.mjs";

export function saveTiers(list) {
  const file = savedTiersFile();
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, `${list}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export function runTiersCommand(args = process.argv.slice(2)) {
  const input = args.join(" ").trim().toLowerCase();
  if (input !== "") {
    const list = input === "reset" ? "" : parseTierList(input);
    if (list === null) {
      process.stderr.write(`Unknown or empty tier list. Choose from ${TIER_NAMES.join(", ")}, or reset.\n`);
      process.exitCode = 2;
      return;
    }
    saveTiers(list);
  }
  process.stdout.write(`Jev routes between ${availableTiers().join(", ")}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTiersCommand();
}
