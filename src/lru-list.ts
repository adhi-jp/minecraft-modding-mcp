interface LruNode<T> {
  key: string;
  value: T;
  prev: LruNode<T> | null;
  next: LruNode<T> | null;
}

/**
 * O(1) doubly-linked list + Map LRU.
 * head = oldest, tail = newest.
 */
export class LruList<T> {
  private map = new Map<string, LruNode<T>>();
  private head: LruNode<T> | null = null;
  private tail: LruNode<T> | null = null;

  get size(): number {
    return this.map.size;
  }

  /** O(1) — move to tail (most recent), return value reference. */
  touch(key: string): T | undefined {
    const node = this.map.get(key);
    if (!node) {
      return undefined;
    }
    this.moveToTail(node);
    return node.value;
  }

  /** O(1) — insert or update + move to tail. Returns previous value if existed. */
  upsert(key: string, value: T): T | undefined {
    const existing = this.map.get(key);
    if (existing) {
      const prev = existing.value;
      existing.value = value;
      this.moveToTail(existing);
      return prev;
    }
    const node: LruNode<T> = { key, value, prev: null, next: null };
    this.map.set(key, node);
    this.appendToTail(node);
    return undefined;
  }

  /** O(1) — remove by key, return removed value. */
  remove(key: string): T | undefined {
    const node = this.map.get(key);
    if (!node) {
      return undefined;
    }
    this.unlink(node);
    this.map.delete(key);
    return node.value;
  }

  /** O(1) — peek at oldest (head) without removing. */
  peekOldest(): { key: string; value: T } | undefined {
    if (!this.head) {
      return undefined;
    }
    return { key: this.head.key, value: this.head.value };
  }

  /** O(1) — clear all entries. */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  /** O(n) — iterate oldest → newest. */
  toArray(): Array<{ key: string; value: T }> {
    const result: Array<{ key: string; value: T }> = [];
    let current = this.head;
    while (current) {
      result.push({ key: current.key, value: current.value });
      current = current.next;
    }
    return result;
  }

  private unlink(node: LruNode<T>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private appendToTail(node: LruNode<T>): void {
    if (!this.tail) {
      this.head = node;
      this.tail = node;
      return;
    }
    node.prev = this.tail;
    this.tail.next = node;
    this.tail = node;
  }

  private moveToTail(node: LruNode<T>): void {
    if (node === this.tail) {
      return;
    }
    this.unlink(node);
    this.appendToTail(node);
  }
}
