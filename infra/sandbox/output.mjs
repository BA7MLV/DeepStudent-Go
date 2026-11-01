// Preview storage is bounded independently of the execution's output budget.
export const previewBytes = 8 * 1024;
export const outputLimitBytes = 16 * 1024 * 1024;

export class OutputPreview {
  bytes = 0;
  head = Buffer.alloc(0);
  tail = Buffer.alloc(0);
  push(chunk) {
    this.bytes += chunk.length;
    const half = previewBytes / 2;
    if (this.head.length < half) {
      const take = Math.min(half - this.head.length, chunk.length);
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
    }
    if (chunk.length) this.tail = Buffer.concat([this.tail, chunk]).subarray(-half);
  }
  result() {
    const truncated = this.bytes > previewBytes;
    // Don't emit replacement characters merely because a preview boundary cuts
    // through a UTF-8 sequence. Full output travels separately as raw bytes.
    const head = this.head.toString('utf8').replace(/\ufffd+$/, '');
    const tail = this.tail.toString('utf8').replace(/^\ufffd+/, '');
    return { text: truncated ? `${head}\n[Output preview truncated; read the saved artifact for full output.]\n${tail}` : Buffer.concat([this.head, this.tail]).toString('utf8'), bytes: this.bytes, truncated };
  }
}
