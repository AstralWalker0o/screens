import { AdapterError, type HubStream } from '../adapters/types';

type Waiter = { pred: (m: string) => boolean; resolve: (m: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One relay stream multiplexed over the gateway link. */
export class RelayStream implements HubStream {
  private queue: string[] = [];
  private waiters: Waiter[] = [];
  closed = false;

  constructor(
    public id: string,
    private sendFrame: (frame: object) => void,
    private onClosed: () => void,
  ) {}

  send(text: string) {
    if (this.closed) throw new AdapterError('closed', 'Stream is closed');
    this.sendFrame({ t: 'stream', stream: this.id, kind: 'text', data: text });
  }

  sendBinary(b64: string) {
    if (this.closed) throw new AdapterError('closed', 'Stream is closed');
    this.sendFrame({ t: 'stream', stream: this.id, kind: 'binary', data_b64: b64 });
  }

  /** Called by the hub for every inbound frame on this stream. */
  deliver(msg: string) {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.pred(msg)) {
        this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
    this.queue.push(msg);
    if (this.queue.length > 100) this.queue.shift();
  }

  next(pred: (m: string) => boolean = () => true, timeoutMs = 10_000): Promise<string> {
    const idx = this.queue.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    if (this.closed) return Promise.reject(new AdapterError('closed', 'Stream closed by device'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new AdapterError('timeout', 'Device did not answer in time'));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  /** Remote side closed (or link dropped). */
  remoteClosed(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new AdapterError('closed', `Stream ${reason}`)); }
    this.waiters = [];
    this.onClosed();
  }

  close() {
    if (this.closed) return;
    try { this.sendFrame({ t: 'stream', stream: this.id, kind: 'close', code: 1000, reason: '' }); } catch { /* link gone */ }
    this.remoteClosed('closed locally');
  }
}
