/** Pending feedback has neither a DOM node nor a running timer. The host calls
 * advance only after the previous toast has actually left (including its exit). */
export class SerialFeedback<T> {
  private pending: Array<{ id: string; value: T }> = [];
  private sequence = 0;
  constructor(private readonly show: (value: T, id: string) => void, private readonly occupied: () => boolean) {}
  add(value: T) {
    const id = `feedback-${++this.sequence}`;
    this.pending.push({ id, value });
    this.advance();
    return id;
  }
  advance() {
    if (this.occupied()) return;
    const next = this.pending.shift();
    if (next) this.show(next.value, next.id);
  }
  remove(id: string) { this.pending = this.pending.filter(item => item.id !== id); }
  clear() { this.pending = []; }
}
