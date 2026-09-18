/**
 * Starts the wake proxy and its services once for the whole Playwright run
 * and hands the addresses to the tests through the environment.
 */
import { startHarness } from "../support/harness";

export interface E2eEnvironment {
  proxyPort: number;
  domain: string;
  baseUrl: string;
}

export const ENV_KEY = "WAKEUP_E2E";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const harness = await startHarness();
  const env: E2eEnvironment = {
    proxyPort: harness.proxyPort,
    domain: harness.domain,
    baseUrl: harness.baseUrl,
  };
  process.env[ENV_KEY] = JSON.stringify(env);
  return () => harness.stop();
}
