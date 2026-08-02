export class SelectionModel {
  private readonly selected = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private anchor: string | null = null;

  has(key: string): boolean {
    return this.selected.has(key);
  }

  size(): number {
    return this.selected.size;
  }

  keys(): readonly string[] {
    return [...this.selected];
  }

  toggle(key: string): void {
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
    this.anchor = key;
    this.notify();
  }

  toggleMany(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const allSelected = keys.every((key) => this.selected.has(key));
    for (const key of keys) {
      if (allSelected) this.selected.delete(key);
      else this.selected.add(key);
    }
    this.anchor = keys.at(-1) ?? this.anchor;
    this.notify();
  }

  selectRange(orderedVisible: readonly string[], toKey: string): void {
    const anchorIndex =
      this.anchor === null ? -1 : orderedVisible.indexOf(this.anchor);
    const toIndex = orderedVisible.indexOf(toKey);
    if (anchorIndex < 0 || toIndex < 0) {
      this.anchor = toKey;
      this.replace([toKey]);
      return;
    }

    const start = Math.min(anchorIndex, toIndex);
    const end = Math.max(anchorIndex, toIndex);
    this.replace(orderedVisible.slice(start, end + 1));
  }

  setAll(keys: readonly string[]): void {
    this.replace(keys);
  }

  retain(allowed: ReadonlySet<string>): void {
    const next = this.keys().filter((key) => allowed.has(key));
    if (this.anchor !== null && !allowed.has(this.anchor)) this.anchor = null;
    if (next.length === this.selected.size) return;
    this.selected.clear();
    for (const key of next) this.selected.add(key);
    this.notify();
  }

  clear(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.anchor = null;
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private replace(keys: readonly string[]): void {
    const next = [...new Set(keys)];
    const current = this.keys();
    if (
      next.length === this.selected.size &&
      next.every((key, index) => key === current[index])
    ) {
      return;
    }
    this.selected.clear();
    for (const key of next) this.selected.add(key);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
