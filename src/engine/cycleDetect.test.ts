import { describe, expect, it } from "vitest";
import { buildAdjacency, topoSortBatches, wouldCreateCycle } from "./cycleDetect";

describe("cycleDetect", () => {
  describe("wouldCreateCycle", () => {
    it("returns true for self-loop", () => {
      expect(wouldCreateCycle([], "a", "a")).toBe(true);
    });

    it("returns false for a simple edge with no path back", () => {
      expect(wouldCreateCycle([{ source: "a", target: "b" }], "b", "c")).toBe(false);
    });

    it("returns true when adding edge creates a cycle", () => {
      // a -> b -> c, adding c -> a creates cycle
      const edges = [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ];
      expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
    });

    it("returns true when target can already reach source", () => {
      const edges = [
        { source: "x", target: "a" },
        { source: "a", target: "b" },
      ];
      expect(wouldCreateCycle(edges, "b", "x")).toBe(true);
    });

    it("returns false for parallel-like branches", () => {
      const edges = [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ];
      expect(wouldCreateCycle(edges, "b", "c")).toBe(false);
      expect(wouldCreateCycle(edges, "c", "b")).toBe(false);
    });
  });

  describe("buildAdjacency", () => {
    it("builds adjacency list from edges", () => {
      const adj = buildAdjacency([
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "d" },
      ]);
      expect(adj.get("a")).toEqual(["b", "c"]);
      expect(adj.get("b")).toEqual(["d"]);
      expect(adj.get("c")).toBeUndefined();
    });
  });

  describe("topoSortBatches", () => {
    it("returns empty array for empty nodes", () => {
      expect(topoSortBatches([], [])).toEqual([]);
    });

    it("puts all nodes with in-degree 0 in first batch", () => {
      const batches = topoSortBatches(["a", "b", "c"], []);
      expect(batches).toHaveLength(1);
      expect(batches[0].sort()).toEqual(["a", "b", "c"]);
    });

    it("respects dependencies across batches", () => {
      const edges = [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ];
      const batches = topoSortBatches(["a", "b", "c"], edges);
      expect(batches).toHaveLength(3);
      expect(batches[0]).toEqual(["a"]);
      expect(batches[1]).toEqual(["b"]);
      expect(batches[2]).toEqual(["c"]);
    });

    it("allows parallel execution in same batch", () => {
      const edges = [
        { source: "a", target: "c" },
        { source: "b", target: "c" },
      ];
      const batches = topoSortBatches(["a", "b", "c"], edges);
      expect(batches).toHaveLength(2);
      expect(batches[0].sort()).toEqual(["a", "b"]);
      expect(batches[1]).toEqual(["c"]);
    });

    it("handles diamond dependency", () => {
      const edges = [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "d" },
        { source: "c", target: "d" },
      ];
      const batches = topoSortBatches(["a", "b", "c", "d"], edges);
      expect(batches).toHaveLength(3);
      expect(batches[0]).toEqual(["a"]);
      expect(batches[1].sort()).toEqual(["b", "c"]);
      expect(batches[2]).toEqual(["d"]);
    });

    it("returns incomplete batches when there is a cycle (indicates cycle)", () => {
      const edges = [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ];
      const batches = topoSortBatches(["a", "b"], edges);
      const total = batches.flat().length;
      expect(total).toBeLessThan(2);
    });
  });
});
