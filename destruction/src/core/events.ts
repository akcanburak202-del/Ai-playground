/**
 * Minimal typed event bus. Producers (projectiles, blasts, destructibles) emit facts about what
 * happened; consumers (effects, audio, HUD telemetry) react. Nothing in the physics depends on a
 * listener existing.
 */
export class EventBus<E extends Record<string, unknown>> {
  private listeners = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as (payload: never) => void);
    return () => set.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) (fn as (p: E[K]) => void)(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
