import { describe, expect, it } from "vitest";
import { LifecycleState } from "../../src/main/lifecycle-state.js";

describe("LifecycleState", () => {
  it("accepts authenticated startup, recovery, and shutdown", () => {
    const lifecycle = new LifecycleState();
    lifecycle.move("probing");
    lifecycle.move("leasing");
    lifecycle.move("ready");
    lifecycle.move("degraded");
    lifecycle.move("probing");
    lifecycle.move("leasing");
    lifecycle.move("ready");
    lifecycle.move("stopping");
    lifecycle.move("stopped");
    expect(lifecycle.current).toBe("stopped");
  });

  it("rejects invalid hidden transitions", () => {
    const lifecycle = new LifecycleState();
    expect(() => lifecycle.move("ready")).toThrow(/invalid lifecycle transition/);
  });
});
