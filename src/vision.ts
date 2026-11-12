// Public Binance USD-M kline files. Same perpetual 1m rows as fapi /klines,
// including taker-buy base volume, and the bucket sends Access-Control-Allow-Origin: *.
// Daily files are published the next day, so "today" is usually missing.

type Row = [number, string, string, string, string, string, number, string, number, string, string, string];

const EARLIEST = '2019-09-01';
const cache = new Map<string, Promise<Row[] | null>>();

export function dayStamp(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

function prevDay(stamp: string): string {
  const [y, m, d] = stamp.split('-').map(Number);
  return dayStamp(Date.UTC(y, m - 1, d) - 86_400_000);
}

/** First entry of a stored or deflate zip (Binance vision files are one CSV). */
export async function unzipOne(buf: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 30 || view.getUint32(0, true) !== 0x04034b50) throw new Error('zip signature');
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const compSize = view.getUint32(18, true);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  if ((flags & 8) !== 0 && compSize === 0) throw new Error('zip data descriptor');
  if (start + compSize > buf.byteLength) throw new Error('zip truncated');
  const slice = buf.subarray(start, start + compSize);
  if (method === 0) return slice;
  if (method !== 8) throw new Error(`zip method ${method}`);
  const copy = new ArrayBuffer(slice.byteLength);
  new Uint8Array(copy).set(slice);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseVisionCsv(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(',');
    if (p.length < 11) continue;
    const open = Number(p[0]);
    const close = Number(p[6]);
    // Unix milliseconds, same as fapi. A 1m candle closes 59999 ms after it opens.
    if (!Number.isFinite(open) || !Number.isFinite(close) || close - open !== 59_999) continue;
    rows.push([open, p[1], p[2], p[3], p[4], p[5], close, p[7], Number(p[8]), p[9], p[10], p[11] ?? '0']);
  }
  return rows;
}

async function fetchDay(symbol: string, stamp: string): Promise<Row[] | null> {
  const url = `https://data.binance.vision/data/futures/um/daily/klines/${symbol}/1m/${symbol}-1m-${stamp}.zip`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`vision ${symbol} ${stamp} ${r.status}`);
  const text = new TextDecoder().decode(await unzipOne(new Uint8Array(await r.arrayBuffer())));
  const rows = parseVisionCsv(text);
  if (!rows.length) throw new Error(`vision ${symbol} ${stamp} empty`);
  return rows;
}

function loadDay(symbol: string, stamp: string): Promise<Row[] | null> {
  const key = `${symbol}:${stamp}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = fetchDay(symbol, stamp).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

/** Up to `limit` klines with open time <= endTime, oldest first. Throws if no file could be read. */
export async function visionKlines(symbol: string, endTime: number, limit: number): Promise<Row[]> {
  const picked: Row[] = [];
  let stamp = dayStamp(endTime);
  let misses = 0;
  let saw = false;
  while (picked.length < limit && stamp >= EARLIEST && misses < 10) {
    let day: Row[] | null;
    try {
      day = await loadDay(symbol, stamp);
    } catch (err) {
      if (picked.length) break;
      throw err;
    }
    if (!day) {
      misses++;
    } else {
      saw = true;
      misses = 0;
      for (let i = day.length - 1; i >= 0 && picked.length < limit; i--) {
        if (day[i][0] <= endTime) picked.push(day[i]);
      }
    }
    stamp = prevDay(stamp);
  }
  if (!saw) throw new Error(`data.binance.vision에 ${symbol} 1분봉이 없습니다`);
  picked.reverse();
  return picked;
}
