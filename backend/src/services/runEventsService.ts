import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type RunEventRecord = Record<string, unknown>;

export type RunEventsResult = {
  runId: string;
  events: RunEventRecord[];
  warnings?: string[];
};

export class RunEventsService {
  constructor(private readonly baseDir = path.resolve(process.cwd(), 'data/runs')) {}

  async tailEvents(runId: string, options: { limit: number; types?: string[] } = { limit: 200 }): Promise<RunEventsResult> {
    const warnings: string[] = [];
    const runDir = path.join(this.baseDir, runId);
    const eventsPath = path.join(runDir, 'events.ndjson');

    await mkdir(this.baseDir, { recursive: true });

    const raw = await readFile(eventsPath, 'utf-8').catch(() => null);
    if (typeof raw !== 'string') {
      warnings.push('events.ndjson missing');
      return { runId, events: [], ...(warnings.length > 0 ? { warnings } : {}) };
    }

    const parsed: RunEventRecord[] = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed) as RunEventRecord;
        parsed.push(item);
      } catch {
        warnings.push('events.ndjson line parse failed');
      }
    }

    const requestedTypes = (options.types ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
    const filtered = requestedTypes.length === 0
      ? parsed
      : parsed.filter((event) => this.matchesTypes(event, requestedTypes));

    const safeLimit = Math.max(1, Math.floor(options.limit));
    const events = filtered.slice(-safeLimit).reverse();
    return { runId, events, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  private matchesTypes(event: RunEventRecord, requestedTypes: string[]): boolean {
    const eventKind = typeof event.type === 'string' ? event.type : null;
    if (eventKind === 'SYSTEM') {
      return true;
    }

    const eventName = typeof event.event === 'string' ? event.event : null;
    if (eventName && requestedTypes.includes(eventName)) {
      return true;
    }

    const payloadType = this.readPayloadType(event);
    if (payloadType && requestedTypes.includes(payloadType)) {
      return true;
    }

    return requestedTypes.includes('SYSTEM') && eventKind === 'SYSTEM';
  }

  private readPayloadType(event: RunEventRecord): string | null {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const typedPayload = payload as Record<string, unknown>;
    return typeof typedPayload.type === 'string' ? typedPayload.type : null;
  }
}
