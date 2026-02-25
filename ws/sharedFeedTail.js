import fs from 'fs';
import path from 'path';

function toMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.message && typeof payload.message === 'object') return payload.message;
  if (payload.raw && typeof payload.raw === 'object') return payload.raw;
  if (payload.data && typeof payload.data === 'object' && payload.data.channel) return payload.data;
  if (payload.channel) return payload;
  return null;
}

function readRange(filePath, start, end) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const rs = fs.createReadStream(filePath, { encoding: 'utf8', start, end });
    rs.on('data', (chunk) => { raw += chunk; });
    rs.on('end', () => resolve(raw));
    rs.on('error', reject);
  });
}

export function createSharedFeedTail(options = {}) {
  const filePath = path.resolve(String(options.filePath || ''));
  const pollMs = Math.max(50, Math.floor(Number(options.pollMs ?? 150)));
  const replayFromStart = options.replayFromStart === true;
  const onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const onInfo = typeof options.onInfo === 'function' ? options.onInfo : () => {};

  let stopped = false;
  let timer = null;
  let offset = 0;
  let carry = '';
  let reading = false;

  async function pump() {
    if (stopped || reading) return;
    reading = true;
    try {
      const st = await fs.promises.stat(filePath);
      if (st.size < offset) {
        offset = 0;
        carry = '';
        onInfo({ type: 'shared_feed_rotated', filePath });
      }
      if (st.size === offset) return;
      const raw = await readRange(filePath, offset, st.size - 1);
      offset = st.size;
      const merged = carry + raw;
      const lines = merged.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const message = toMessage(parsed);
          if (!message) continue;
          onMessage(message);
        } catch (err) {
          onError(new Error(`[shared-feed] parse failed: ${err?.message ?? err}`));
        }
      }
    } catch (err) {
      onError(err);
    } finally {
      reading = false;
    }
  }

  async function start() {
    if (!filePath) throw new Error('shared feed filePath is required');
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(filePath, '');
      const st = await fs.promises.stat(filePath);
      offset = replayFromStart ? 0 : st.size;
      carry = '';
      onInfo({ type: 'shared_feed_started', filePath, replayFromStart });
      timer = setInterval(() => {
        pump().catch(() => {});
      }, pollMs);
      if (timer.unref) timer.unref();
    } catch (err) {
      onError(err);
    }
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop };
}
