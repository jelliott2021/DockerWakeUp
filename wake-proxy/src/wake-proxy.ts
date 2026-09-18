/**
 * Entry point (`node dist/wake-proxy.js`): load config.json and start the
 * wake proxy. Everything else lives in the modules next to this file.
 */
import { loadConfig, resolveConfigPath } from "./config";
import { startServer } from "./server";

// A proxy fronting every service must not die because one request hit an
// unexpected error path — log loudly instead of crashing
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in wake-proxy:", reason);
});

startServer(loadConfig(resolveConfigPath()));
