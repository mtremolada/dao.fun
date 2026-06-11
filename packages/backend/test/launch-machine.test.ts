/**
 * Spec 6.6 — orchestrator step machine (written before implementation).
 * Idempotency keys per step; partial failure -> resumable state; resume
 * completes only what's missing; a second resume is a no-op. Real chain
 * steps are wired in steps.ts and exercised by the integration suite.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MemoryLaunchStore,
  runLaunch,
  type LaunchStep,
} from "../src/launch-machine";

function steps(log: string[], failOn?: string): LaunchStep[] {
  const names = [
    "create-treasury",
    "collect-launch-fee",
    "create-token",
    "create-dao",
    "assert-invariants",
  ];
  return names.map((name) => ({
    name,
    run: vi.fn(async () => {
      if (name === failOn) throw new Error(`${name} exploded`);
      log.push(name);
      return [`sig-${name}`];
    }),
  }));
}

describe("runLaunch", () => {
  it("executes all steps in order and records signatures per step", async () => {
    const store = new MemoryLaunchStore();
    const log: string[] = [];
    const state = await runLaunch("launch-1", steps(log), store);
    expect(state.status).toBe("complete");
    expect(log).toEqual([
      "create-treasury",
      "collect-launch-fee",
      "create-token",
      "create-dao",
      "assert-invariants",
    ]);
    expect(state.completedSteps["create-token"]).toEqual(["sig-create-token"]);
  });

  it("partial failure returns a resumable state with completed steps intact", async () => {
    const store = new MemoryLaunchStore();
    const log: string[] = [];
    const state = await runLaunch("launch-2", steps(log, "create-token"), store);
    expect(state.status).toBe("failed");
    expect(state.failedStep).toBe("create-token");
    expect(Object.keys(state.completedSteps)).toEqual([
      "create-treasury",
      "collect-launch-fee",
    ]);
    expect(state.error).toMatch(/create-token exploded/);
  });

  it("resume runs ONLY the missing steps (idempotency keys honored)", async () => {
    const store = new MemoryLaunchStore();
    await runLaunch("launch-3", steps([], "create-token"), store);

    const log: string[] = [];
    const resumed = await runLaunch("launch-3", steps(log), store);
    expect(resumed.status).toBe("complete");
    expect(log).toEqual(["create-token", "create-dao", "assert-invariants"]);
  });

  it("a second resume of a complete launch is a no-op", async () => {
    const store = new MemoryLaunchStore();
    await runLaunch("launch-4", steps([]), store);
    const log: string[] = [];
    const again = await runLaunch("launch-4", steps(log), store);
    expect(again.status).toBe("complete");
    expect(log).toEqual([]); // nothing re-executed
  });

  it("state is persisted after every step, not only at the end", async () => {
    const store = new MemoryLaunchStore();
    await runLaunch("launch-5", steps([], "create-dao"), store);
    const persisted = await store.load("launch-5");
    expect(persisted).not.toBeNull();
    expect(Object.keys(persisted!.completedSteps)).toContain("create-token");
  });
});
