import { test, expect } from "@playwright/test";
import { ENV_KEY, type E2eEnvironment } from "./global-setup";

const env = JSON.parse(process.env[ENV_KEY] ?? "{}") as E2eEnvironment;
/** `http://<route>.test.local:<port><path>` — resolved to the proxy by the browser */
const serviceUrl = (route: string, path = "/") =>
  `http://${route}.${env.domain}:${env.proxyPort}${path}`;

test.describe("wake page", () => {
  test("a sleeping service shows the wake page with live logs, then reloads into the app", async ({
    page,
  }) => {
    await page.goto(serviceUrl("dozy"));
    await expect(page).toHaveTitle("Starting dozy…");
    await expect(page.locator("#svc")).toHaveText("dozy");
    await expect(page.locator("#spinner")).toBeVisible();
    await expect(page.locator("#log")).toContainText("booting");
    await expect(page.locator("#log")).toContainText("ready");

    // The page polls __wake/status and reloads itself once the service answers
    await expect(page.locator("#app")).toHaveText("dozy service is running", { timeout: 20_000 });
    await expect(page).toHaveTitle("dozy is up");
    expect(page.url()).toBe(serviceUrl("dozy"));
  });

  test("a failed wake shows the error and offers a retry", async ({ page }) => {
    await page.goto(serviceUrl("never"));
    await expect(page).toHaveTitle("Starting never…");
    await expect(page.locator("#status-line")).toHaveText("Startup failed.", { timeout: 20_000 });
    await expect(page.locator("#error")).toBeVisible();
    await expect(page.locator("#error")).toContainText("Command failed");
    await expect(page.locator("#error button")).toHaveText("Retry");
  });

  test("a custom wake page is served and reloads into the app as well", async ({ page }) => {
    await page.goto(serviceUrl("custom"));
    await expect(page).toHaveTitle("custom is waking up");
    await expect(page.locator("h1")).toContainText("Hang tight — custom is waking up");
    await expect(page.locator("#app")).toHaveText("custom service is running", { timeout: 20_000 });
  });
});

test.describe("routing", () => {
  test("a running service is proxied straight through by hostname", async ({ page }) => {
    await page.goto(serviceUrl("up"));
    await expect(page).toHaveTitle("up is up");
    await expect(page.locator("#app")).toHaveText("up service is running");
  });

  test("the path-prefixed form works without a service hostname", async ({ page }) => {
    await page.goto(`${env.baseUrl}/proxy/up/`);
    await expect(page.locator("#app")).toHaveText("up service is running");
  });

  test("the wake status endpoint answers for a service hostname", async ({ request }) => {
    // The *.test.local mapping only exists inside the browser; Node's request
    // client reaches the proxy directly and names the service via Host
    const res = await request.get(`${env.baseUrl}/__wake/status`, {
      headers: { Host: `up.${env.domain}` },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ready: true });
  });
});
