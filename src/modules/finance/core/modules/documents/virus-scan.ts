import { Socket } from 'node:net';

export type ScanResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string } | { status: 'ERROR'; message: string } | { status: 'NOT_SCANNED' };

/** Whether a scanner is configured (CLAMAV_HOST, optionally CLAMAV_PORT). */
export const scannerConfigured = () => !!process.env.CLAMAV_HOST;

/**
 * Whether files must be scanned before they are accepted. On by default when a scanner is configured:
 * with the scanner down, uploads are refused rather than accepted unchecked. Set ATTACHMENT_SCAN_REQUIRED=false
 * to accept them as unscanned and have the scheduled run scan them later.
 */
export const scanRequired = () => scannerConfigured() && process.env.ATTACHMENT_SCAN_REQUIRED !== 'false';

/**
 * Scans bytes with ClamAV (clamd's INSTREAM command over TCP): the file is streamed in chunks, each
 * prefixed with its 4-byte big-endian length, ending with a zero-length chunk; clamd answers
 * "stream: OK" or "stream: <signature> FOUND".
 */
export async function scanBuffer(data: Buffer, opts: { timeoutMs?: number } = {}): Promise<ScanResult> {
  const host = process.env.CLAMAV_HOST;
  if (!host) return { status: 'NOT_SCANNED' };
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  return new Promise<ScanResult>((resolve) => {
    const socket = new Socket();
    let answer = '';
    let settled = false;
    const finish = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(opts.timeoutMs ?? 30_000, () => finish({ status: 'ERROR', message: 'The virus scanner did not answer in time' }));
    socket.on('error', (err) => finish({ status: 'ERROR', message: `The virus scanner could not be reached: ${err.message}` }));
    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8');
      if (answer.includes('\0') || answer.includes('\n')) socket.end();
    });
    socket.on('close', () => {
      const text = answer.replace(/\0/g, '').trim();
      if (!text) return finish({ status: 'ERROR', message: 'The virus scanner closed the connection without an answer' });
      if (/:\s*OK$/.test(text)) return finish({ status: 'CLEAN' });
      const found = /:\s*(.+)\s+FOUND$/.exec(text);
      if (found) return finish({ status: 'INFECTED', signature: found[1] });
      finish({ status: 'ERROR', message: `The virus scanner answered: ${text.slice(0, 200)}` });
    });
    socket.connect(port, host, () => {
      socket.write('zINSTREAM\0');
      const size = 64 * 1024;
      for (let i = 0; i < data.length; i += size) {
        const part = data.subarray(i, i + size);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length, 0);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
