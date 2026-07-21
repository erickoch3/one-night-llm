import { createServer } from "node:net";

export function parsePreferredPort(rawValue) {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("ONE_NIGHT_API_PORT must be an integer from 1 through 65535.");
  }
  return value;
}

export async function findAvailablePort(
  preferredPort,
  { isAvailable = portIsAvailable, attempts = 100 } = {},
) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65_535) break;
    if (await isAvailable(port)) return port;
  }
  const finalPort = Math.min(preferredPort + attempts - 1, 65_535);
  throw new Error(
    `No free game-service port was found from ${preferredPort} through ${finalPort}.`,
  );
}

export function buildChildEnvironment(baseEnvironment, apiPort) {
  return {
    ...baseEnvironment,
    ONE_NIGHT_API_PORT: String(apiPort),
    NEXT_PUBLIC_GAME_API_URL: `http://localhost:${apiPort}`,
  };
}

export function portIsAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}
