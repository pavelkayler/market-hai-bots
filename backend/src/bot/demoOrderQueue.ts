export type DemoOrderJob = {
  symbol: string;
  execute: () => Promise<void>;
};

export type DemoQueueSnapshot = {
  depth: number;
  lastJobLatencyMs: number | null;
  lastError: string | null;
};

export class DemoOrderQueue {
  private readonly jobs: DemoOrderJob[] = [];
  private activeJob: DemoOrderJob | null = null;
  private snapshot: DemoQueueSnapshot = {
    depth: 0,
    lastJobLatencyMs: null,
    lastError: null
  };

  constructor(private readonly onUpdate: (snapshot: DemoQueueSnapshot) => void) {}

  enqueue(job: DemoOrderJob): void {
    this.jobs.push(job);
    this.publish();
    this.runNext();
  }

  getDepth(): number {
    return this.jobs.length + (this.activeJob ? 1 : 0);
  }

  removePendingJob(symbol: string): boolean {
    const idx = this.jobs.findIndex((job) => job.symbol === symbol);
    if (idx < 0) {
      return false;
    }

    this.jobs.splice(idx, 1);
    this.publish();
    return true;
  }

  private runNext(): void {
    if (this.activeJob || this.jobs.length === 0) {
      return;
    }

    this.activeJob = this.jobs.shift() ?? null;
    this.publish();

    if (!this.activeJob) {
      return;
    }

    const startedAt = Date.now();

    void this.activeJob
      .execute()
      .catch((error: unknown) => {
        this.snapshot.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.snapshot.lastJobLatencyMs = Date.now() - startedAt;
        this.activeJob = null;
        this.publish();
        this.runNext();
      });
  }

  private publish(): void {
    this.snapshot = {
      ...this.snapshot,
      depth: this.getDepth()
    };
    this.onUpdate({ ...this.snapshot });
  }
}
