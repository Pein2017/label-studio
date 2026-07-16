import { CoordExpRefinementClient, createBatchId } from "./coordexp-refinement-api";

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
});

describe("CoordExpRefinementClient", () => {
  it("binds the default browser fetch to its owning global receiver", async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const browserFetch = jest.fn(function () {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response(200, { version: 1, generation: 2 }));
    });

    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: browserFetch });
    try {
      const client = new CoordExpRefinementClient(7);

      await expect(client.projectState()).resolves.toEqual({ version: 1, generation: 2 });
      expect(browserFetch.mock.instances).toEqual([globalThis]);
    } finally {
      if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
      else delete globalThis.fetch;
    }
  });

  it("uses the exact same-origin read endpoints", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(200, { csrf_token: "masked-token" }))
      .mockResolvedValueOnce(response(200, { version: 1, generation: 2 }))
      .mockResolvedValueOnce(response(200, { batch_id: "batch", status: "running" }))
      .mockResolvedValueOnce(response(200, { profiles: [] }));
    const client = new CoordExpRefinementClient(7, fetchImpl);

    await expect(client.session()).resolves.toEqual({ csrf_token: "masked-token" });
    await expect(client.projectState()).resolves.toEqual({ version: 1, generation: 2 });
    await expect(client.status("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      status: "running",
    });
    await expect(client.profiles()).resolves.toEqual({ profiles: [] });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/7/coordexp-refinement/session/",
      "/api/projects/7/coordexp-refinement/project-state/",
      "/api/projects/7/coordexp-refinement/status/?batch_id=11111111-1111-4111-8111-111111111111",
      "/api/projects/7/coordexp-refinement/roi/profiles/",
    ]);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options).toMatchObject({ cache: "no-store", credentials: "same-origin", method: "GET" });
    }
  });

  it("gets a fresh session token before each exact state-changing request", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(200, { csrf_token: "commit-token" }))
      .mockResolvedValueOnce(response(202, { batch_id: "batch", status: "queued" }))
      .mockResolvedValueOnce(response(200, { csrf_token: "infer-token" }))
      .mockResolvedValueOnce(response(200, { request_state: "produced" }))
      .mockResolvedValueOnce(response(200, { csrf_token: "abandon-token" }))
      .mockResolvedValueOnce(response(200, { terminal_status: "abandoned" }));
    const client = new CoordExpRefinementClient(7, fetchImpl);

    await expect(client.commit("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({ status: 202 });
    await client.infer({
      requestId: "22222222-2222-4222-8222-222222222222",
      taskId: 19,
      roi: { x: 1, y: 2, width: 30, height: 40, ignored: true },
      resolution: { width: 1024, height: 768, ignored: true },
      profileSelector: "accepted-profile",
    });
    await client.abandon({ receiptId: "roi-receipt:22222222-2222-4222-8222-222222222222", reason: "superseded" });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/projects/7/coordexp-refinement/commit/",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
        headers: expect.objectContaining({ "X-CSRFToken": "commit-token" }),
        body: JSON.stringify({ batch_id: "11111111-1111-4111-8111-111111111111" }),
      }),
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/projects/7/coordexp-refinement/session/");
    expect(fetchImpl.mock.calls[2][0]).toBe("/api/projects/7/coordexp-refinement/session/");
    expect(fetchImpl.mock.calls[4][0]).toBe("/api/projects/7/coordexp-refinement/session/");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "/api/projects/7/coordexp-refinement/roi/infer/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRFToken": "infer-token" }),
        body: JSON.stringify({
          request_id: "22222222-2222-4222-8222-222222222222",
          task_id: 19,
          roi: { x: 1, y: 2, width: 30, height: 40 },
          resolution: { width: 1024, height: 768 },
          profile_selector: "accepted-profile",
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      6,
      "/api/projects/7/coordexp-refinement/roi/abandon/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRFToken": "abandon-token" }),
        body: JSON.stringify({
          receipt_id: "roi-receipt:22222222-2222-4222-8222-222222222222",
          reason: "superseded",
        }),
      }),
    );
  });

  it("rejects resolved HTTP errors instead of treating them as success", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        response(409, { error: { code: "batch_busy", message: "The split is busy or reconciling." } }),
      );
    const client = new CoordExpRefinementClient(7, fetchImpl);

    await expect(client.projectState()).rejects.toMatchObject({
      code: "batch_busy",
      message: "The split is busy or reconciling.",
      status: 409,
    });
  });

  it("marks a lost POST response as outcome-unknown after CSRF succeeds", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(200, { csrf_token: "masked-token" }))
      .mockRejectedValueOnce(new TypeError("connection closed"));
    const client = new CoordExpRefinementClient(7, fetchImpl);

    await expect(client.commit("11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
      outcomeUnknown: true,
    });
  });

  it("creates a canonical v4 UUID with the secure fallback", () => {
    const cryptoObject = {
      getRandomValues: (bytes) => {
        bytes.fill(0);
        return bytes;
      },
    };

    expect(createBatchId(cryptoObject)).toBe("00000000-0000-4000-8000-000000000000");
  });
});
