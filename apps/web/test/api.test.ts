import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api", () => {
  it("rejects a request aborted while its body is read instead of resolving it empty", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        },
      })),
    );
    await expect(api.screen("0000-0001", "Pre-op check", controller.signal)).rejects.toThrow();
  });
});
