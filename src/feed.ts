// Binance USDⓈ-M futures BTCUSDT 1m Datafeed for Funnest Charts. Public endpoints only, no keys.
import { ReconnectingWebSocket, toConnectionStatus, type Bar, type BarsRequest, type BarsResult, type ConnectionState, type Datafeed, type Quote, type Resolution, type SymbolInfo } from '@funnest/charts';
import type { KBar } from './engine';
import { visionKlines } from './vision';

const FAPI_HOSTS = ['https://fapi.binance.com', 'https://fapi1.binance.com'];
const WS = 'wss://fstream.binance.com/market/ws';
type Row = [number, string, string, string, string, string, number, string, number, string, ...unknown[]];
export interface Stored extends KBar { closed: boolean }

export const HISTORY_ERROR_KO = 'BTCUSDT 무기한 1분봉을 불러오지 못했습니다. 이 브라우저에서 바이낸스 선물 REST가 막혀 있고, 같은 봉을 제공하는 공개 파일(data.binance.vision)도 받지 못했습니다. 네트워크를 확인한 뒤 새로고침해 주세요.';

export class UltraFeed implements Datafeed {
  /** time -> bar (incl. taker buy volume); the strategy engine reads this. */
  readonly store = new Map<number, Stored>();
  /** direct: fapi. vision: data.binance.vision daily files. server: optional /api/klines. */
  mode: 'direct' | 'vision' | 'server' | 'error' | 'unknown' = 'unknown';
  errorMessage = '';
  serverSource = '';
  wsStatus = 'connecting';
  lastMsg = 0;
  maxTime = 0;
  onChange: (closedBarAdded: boolean) => void = () => {};

  info: SymbolInfo = {
    symbol: 'BTCUSDT', name: 'BTC/USDT 무기한', exchange: 'Binance Futures', timezone: 'Asia/Seoul', session: '24x7',
    pricePrecision: 1, tickSize: 0.1, type: 'futures', supportedResolutions: ['1'],
  };
  async resolveSymbol(): Promise<SymbolInfo> { return this.info; }
  async searchSymbols(): Promise<SymbolInfo[]> { return [this.info]; }

  private async directHost(host: string, q: string): Promise<Row[]> {
    const r = await fetch(`${host}/fapi/v1/klines?${q}`, { signal: AbortSignal.timeout(8000) });
    if (r.status !== 200) throw new Error(String(r.status));
    const data: unknown = await r.json();
    if (!Array.isArray(data)) throw new Error('bad kline');
    if (data.length && (!Array.isArray(data[0]) || (data[0] as unknown[]).length < 10)) throw new Error('bad kline');
    return data as Row[];
  }

  private async direct(q: string): Promise<Row[]> {
    try {
      return await Promise.any(FAPI_HOSTS.map((host) => this.directHost(host, q)));
    } catch (err) {
      const first = err instanceof AggregateError ? err.errors.find((e) => e instanceof Error) : err;
      throw first instanceof Error ? first : new Error('fapi failed');
    }
  }

  /** Last resort for a self-hosted /api/klines. On Pages this 404s and is ignored. */
  private async tryApi(q: string): Promise<Row[] | null> {
    try {
      const r = await fetch(`/api/klines?${q}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return null;
      const data: unknown = await r.json();
      if (!Array.isArray(data)) return null;
      if (data.length && (!Array.isArray(data[0]) || (data[0] as unknown[]).length < 10)) return null;
      this.serverSource = r.headers.get('x-source') ?? '';
      return data as Row[];
    } catch {
      return null;
    }
  }

  private failHistory(): never {
    this.mode = 'error';
    this.errorMessage = HISTORY_ERROR_KO;
    this.onChange(false);
    throw new Error(this.errorMessage);
  }

  private async rows(endTime: number, limit: number): Promise<Row[]> {
    const q = `symbol=BTCUSDT&interval=1m&limit=${limit}&endTime=${endTime}`;
    if (this.mode !== 'vision' && this.mode !== 'server') {
      try {
        const rows = await this.direct(q);
        this.mode = 'direct';
        this.errorMessage = '';
        return rows;
      } catch (err) {
        if (this.mode === 'direct') throw err;
      }
    }
    if (this.mode !== 'server') {
      try {
        const rows = await visionKlines(endTime, limit);
        this.mode = 'vision';
        this.errorMessage = '';
        return rows as Row[];
      } catch (err) {
        if (this.mode === 'vision') throw err;
      }
    }
    const api = await this.tryApi(q);
    if (api) {
      this.mode = 'server';
      this.errorMessage = '';
      return api;
    }
    this.failHistory();
  }

  private ingest(rows: Row[]): void {
    const now = Date.now();
    for (const k of rows) {
      const prev = this.store.get(k[0]);
      if (prev?.closed) continue; // a closed bar never changes
      this.maxTime = Math.max(this.maxTime, k[0]);
      this.store.set(k[0], { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], takerBuy: +k[9], closed: k[6] < now });
    }
  }

  async getBars(_info: SymbolInfo, _res: Resolution, req: BarsRequest): Promise<BarsResult> {
    const wanted = req.countBack ?? Math.ceil((req.to - req.from) / 60000);
    let end = req.to, got: Row[] = [], done = false;
    while (got.length < wanted) {
      const limit = Math.min(1500, wanted - got.length);
      const rows = await this.rows(end, limit);
      got = rows.concat(got);
      if (rows.length < limit || !rows[0]) { done = true; break; }
      end = rows[0][0] - 1;
    }
    this.ingest(got);
    this.onChange(true);
    const bars: Bar[] = got.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    return { bars, noMoreData: done };
  }

  /** Refetch the last bars (after a WS gap) so no closed bar is missing. */
  async heal(): Promise<void> {
    try { this.ingest(await this.rows(Date.now() + 60000, 30)); this.onChange(true); } catch { /* next bar retries */ }
  }

  subscribeBars(_i: SymbolInfo, _r: Resolution, onBar: (bar: Bar) => void, onResetCache?: () => void, onConnection?: (s: ConnectionState) => void) {
    const socket = new ReconnectingWebSocket(`${WS}/btcusdt@kline_1m`, {
      idleTimeout: 30_000,
      onOpen: (_ws, reconnected) => { if (reconnected) { onResetCache?.(); void this.heal(); } },
      onStatus: (s) => { this.wsStatus = s; onConnection?.({ status: toConnectionStatus(s) }); this.onChange(false); },
      onMessage: (text) => {
        const k = (JSON.parse(text) as { k?: { t: number; o: string; h: string; l: string; c: string; v: string; V: string; x: boolean } }).k;
        if (!k) return;
        this.lastMsg = Date.now();
        const prevLast = this.maxTime;
        this.maxTime = Math.max(this.maxTime, k.t);
        const bar: Stored = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, takerBuy: +k.V, closed: k.x };
        if (!this.store.get(k.t)?.closed) this.store.set(k.t, bar);
        // the previous bar is closed once a newer bar starts
        const p = this.store.get(k.t - 60000);
        let closedAdded = k.x;
        if (p && !p.closed) { p.closed = true; closedAdded = true; }
        if (!p && prevLast && k.t - prevLast > 60000) void this.heal();
        onBar({ time: k.t, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
        this.onChange(closedAdded);
      },
    });
    return () => socket.close();
  }

  subscribeQuotes(_i: SymbolInfo, onQuote: (q: Quote) => void) {
    const socket = new ReconnectingWebSocket(`${WS}/btcusdt@ticker`, {
      onMessage: (text) => {
        const d = JSON.parse(text) as Record<string, string>;
        if (d.e === '24hrTicker') onQuote({ price: +d.c, change: +d.p, changePercent: +d.P, high24h: +d.h, low24h: +d.l, volume24h: +d.v, turnover24h: +d.q });
      },
    });
    return () => socket.close();
  }

  /** Sorted closed bars and the forming bar (if any). */
  snapshot(): { closed: Stored[]; forming: Stored | null } {
    const all = [...this.store.values()].sort((a, b) => a.time - b.time);
    const last = all.at(-1);
    const forming = last && !last.closed ? last : null;
    return { closed: all.filter((b) => b.closed), forming };
  }
}
