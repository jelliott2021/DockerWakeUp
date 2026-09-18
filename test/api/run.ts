/**
 * Runs the Postman collection against a freshly started proxy with newman.
 *
 *   npm run test:api        (builds wake-proxy first)
 *
 * The same collection can be imported into Postman; the environment values
 * printed at startup are what to put in a Postman environment.
 */
import newman from "newman";
import path from "path";
import { startHarness } from "../support/harness";

const COLLECTION = path.join(__dirname, "DockerWakeUp.postman_collection.json");

async function main(): Promise<number> {
  const harness = await startHarness();
  const envValues = {
    baseUrl: harness.baseUrl,
    domain: harness.domain,
    upHost: harness.up.host,
    sleepyHost: harness.sleepy.host,
    dozyHost: harness.dozy.host,
    neverHost: harness.never.host,
    customHost: harness.custom.host,
    upPort: String(harness.up.port),
  };
  console.log("Postman environment:", envValues);

  try {
    return await new Promise<number>((resolve, reject) => {
      newman.run(
        {
          collection: COLLECTION,
          envVar: Object.entries(envValues).map(([key, value]) => ({ key, value })),
          reporters: ["cli"],
          timeoutRequest: 10_000,
          bail: false,
        },
        (err, summary) => {
          if (err) return reject(err);
          const failures = summary.run.failures.length;
          const errors = summary.error ? 1 : 0;
          resolve(failures + errors > 0 ? 1 : 0);
        },
      );
    });
  } finally {
    await harness.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
