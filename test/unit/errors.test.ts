import { describe, expect, it } from "vitest";
import { messageOf } from "../../src/shared/errors.js";

describe("messageOf", () => {
  it("reads an Error, an error-like object such as an ACP JSON-RPC error, or anything else", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf({ code: -32000, message: "Authentication required" })).toBe("Authentication required");
    expect(messageOf({ message: 42 })).toBe("42");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(undefined)).toBe("undefined");
  });
});
