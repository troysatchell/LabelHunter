import { expect, test } from "@playwright/test";

test("app boots and serves a 200 from the health endpoint", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(body.service).toBe("labelhunter");
});
