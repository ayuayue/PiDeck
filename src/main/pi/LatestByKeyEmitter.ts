/**
 * 按 key 收集最新值，在窗口期内去重节流，到期只回调每个 key 的最新值。
 * 适用于高频增量更新（如 thinking delta），只需最后一次值的场景。
 */
export class LatestByKeyEmitter<K, V> {
  private readonly timers = new Map<K, ReturnType<typeof setTimeout>>();
  private readonly latest = new Map<K, V>();

  constructor(
    private readonly windowMs: number,
    private readonly callback: (key: K, value: V) => void,
  ) {}

  push(key: K, value: V): void {
    this.latest.set(key, value);
    if (!this.timers.has(key)) {
      this.timers.set(
        key,
        setTimeout(() => this.flush(key), this.windowMs),
      );
    }
  }

  flush(key: K): void {
    const timer = this.timers.get(key);
    if (timer != null) clearTimeout(timer);
    this.timers.delete(key);
    const value = this.latest.get(key);
    if (value !== undefined) {
      this.latest.delete(key);
      this.callback(key, value);
    }
  }

  cancel(key: K): void {
    const timer = this.timers.get(key);
    if (timer != null) clearTimeout(timer);
    this.timers.delete(key);
    this.latest.delete(key);
  }
}
