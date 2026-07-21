import { spawn } from "node:child_process";
import {
  buildChildEnvironment,
  findAvailablePort,
  parsePreferredPort,
} from "./dev-runtime.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; start with npm run dev.");

const preferredApiPort = parsePreferredPort(
  process.env.ONE_NIGHT_API_PORT ?? "4318",
);
const apiPort = await findAvailablePort(preferredApiPort);
const childEnvironment = buildChildEnvironment(process.env, apiPort);

const children = [
  spawn(process.execPath, [npmCli, "run", "dev:api"], {
    stdio: "inherit",
    env: childEnvironment,
  }),
  spawn(process.execPath, [npmCli, "run", "dev:web"], {
    stdio: "inherit",
    env: childEnvironment,
  }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping) {
      stop();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
