/**
 * Orchestrator step machine — spec 6.6. Relocated to the SDK (D-033) so the
 * launch ceremony can run client-side in the browser, not only in a server.
 *
 * Each launch step has an idempotency key (its name) and is executed at
 * most once per launch: state is persisted after EVERY step, so a crash or
 * partial failure yields a resumable state object, and resume runs only
 * what is missing. The dangerous partial states are pre-launch only — the
 * pump creator is set inside the create instruction itself (INV-1), so no
 * step ordering can produce a token with the wrong creator; we assert
 * anyway in the final step.
 */
export interface LaunchStep {
  name: string;
  /** Executes the step; returns the tx signatures it produced. */
  run(state: LaunchState): Promise<string[]>;
}

export interface LaunchState {
  launchId: string;
  status: "running" | "complete" | "failed";
  completedSteps: Record<string, string[]>;
  failedStep?: string;
  error?: string;
}

export interface LaunchStore {
  load(launchId: string): Promise<LaunchState | null>;
  save(state: LaunchState): Promise<void>;
}

export class MemoryLaunchStore implements LaunchStore {
  private states = new Map<string, LaunchState>();

  async load(launchId: string): Promise<LaunchState | null> {
    const state = this.states.get(launchId);
    return state ? structuredClone(state) : null;
  }

  async save(state: LaunchState): Promise<void> {
    this.states.set(state.launchId, structuredClone(state));
  }
}

export async function runLaunch(
  launchId: string,
  steps: LaunchStep[],
  store: LaunchStore,
): Promise<LaunchState> {
  const state: LaunchState = (await store.load(launchId)) ?? {
    launchId,
    status: "running",
    completedSteps: {},
  };
  state.status = "running";
  delete state.failedStep;
  delete state.error;

  for (const step of steps) {
    if (state.completedSteps[step.name]) continue; // idempotency key hit

    try {
      const signatures = await step.run(state);
      state.completedSteps[step.name] = signatures;
      await store.save(state);
    } catch (e) {
      state.status = "failed";
      state.failedStep = step.name;
      state.error = e instanceof Error ? e.message : String(e);
      await store.save(state);
      return state;
    }
  }

  state.status = "complete";
  await store.save(state);
  return state;
}
