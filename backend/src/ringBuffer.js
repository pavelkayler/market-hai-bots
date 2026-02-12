// backend/src/ringBuffer.js

export class RingBuffer {
  constructor(capacity) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error("RingBuffer: invalid capacity");
    }
    this.capacity = capacity | 0;
    this.arr = new Array(this.capacity);
    this.head = 0; // next write index
    this.size = 0;
  }

  push(v) {
    this.arr[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  toArray() {
    const out = new Array(this.size);
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      out[i] = this.arr[(start + i) % this.capacity];
    }
    return out;
  }

  last(n = 1) {
    const k = Math.max(0, Math.min(this.size, n | 0));
    if (k === 0) return [];
    const out = new Array(k);
    const start = (this.head - k + this.capacity) % this.capacity;
    for (let i = 0; i < k; i++) {
      out[i] = this.arr[(start + i) % this.capacity];
    }
    return out;
  }
}
