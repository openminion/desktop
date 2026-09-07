import type { DaemonState } from "../shared/contracts.js";

const transitions: Record<DaemonState, Set<DaemonState>> = {
  idle: new Set(["probing", "stopping"]),
  probing: new Set(["starting", "leasing", "degraded", "stopping"]),
  starting: new Set(["leasing", "degraded", "stopping"]),
  leasing: new Set(["ready", "degraded", "stopping"]),
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
