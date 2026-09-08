import type { DaemonState } from "../shared/contracts.js";

const transitions: Record<DaemonState, Set<DaemonState>> = {
  idle: new Set(["probing", "stopping"]),
  probing: new Set(["starting", "degraded", "stopping"]),
  starting: new Set(["running", "degraded", "stopping"]),
  running: new Set(["degraded", "stopping"]),
  ready: new Set(["degraded", "stopping"]),
  degraded: new Set(["probing", "stopping"]),
  stopping: new Set(["stopped", "degraded"]),
  stopped: new Set(["probing"]),
};

export class LifecycleState {
  #state: DaemonState = "idle";

  get current(): DaemonState {
    return this.#state;
  }

  move(next: DaemonState): void {
    if (!transitions[this.#state].has(next)) {
      throw new Error(`invalid lifecycle transition ${this.#state} -> ${next}`);
    }
    this.#state = next;
  }
}
