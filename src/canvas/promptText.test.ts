import { describe, expect, it } from "vitest";
import { mainText } from "./promptText";

describe("promptText", () => {
  describe("mainText", () => {
    it("returns optimizedPrompt when present", () => {
      expect(mainText({ optimizedPrompt: "优化后的提示词", prompt: "原始" })).toBe(
        "优化后的提示词"
      );
    });

    it("falls back to prompt when optimizedPrompt missing", () => {
      expect(mainText({ prompt: "原始描述" })).toBe("原始描述");
    });

    it("falls back to prompt when optimizedPrompt is empty string", () => {
      expect(mainText({ optimizedPrompt: "", prompt: "原始描述" })).toBe("原始描述");
    });

    it("falls back to prompt when optimizedPrompt is whitespace only", () => {
      expect(mainText({ optimizedPrompt: "   ", prompt: "原始描述" })).toBe("原始描述");
    });

    it("returns empty string when both missing", () => {
      expect(mainText({})).toBe("");
    });

    it("returns empty string for null/undefined", () => {
      expect(mainText(null as any)).toBe("");
      expect(mainText(undefined as any)).toBe("");
    });

    it("coerces non-string values", () => {
      expect(mainText({ prompt: 123 as any })).toBe("123");
      expect(mainText({ optimizedPrompt: 456 as any })).toBe("456");
    });
  });
});
