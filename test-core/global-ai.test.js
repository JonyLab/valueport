import { describe, it, expect } from "vitest";
import { pageFromPath } from "../public/shared/global-ai.js";

describe("global AI page context", () => {
  it("derives the page kind from the path", () => {
    expect(pageFromPath("/b/demo")).toEqual({ kind: "watchlist" });
    expect(pageFromPath("/b/demo/")).toEqual({ kind: "watchlist" });
    expect(pageFromPath("/b/demo/AAPL")).toEqual({ kind: "stock", symbol: "AAPL" });
    expect(pageFromPath("/b/demo/00700")).toEqual({ kind: "stock", symbol: "00700" });
    expect(pageFromPath("/portfolio")).toEqual({ kind: "portfolio" });
    expect(pageFromPath("/macro")).toEqual({ kind: "macro" });
    expect(pageFromPath("/")).toEqual({ kind: "other" });
  });
});
