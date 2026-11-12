// Binance USDⓈ-M futures 1m Datafeed for Funnest Charts. Public endpoints only, no keys.
import { ReconnectingWebSocket, toConnectionStatus, type Bar, type BarsRequest, type BarsResult, type ConnectionState, type Datafeed, type Quote, type Resolution, type SymbolInfo } from '@funnest/charts';
import type { KBar } from './engine';
import { visionKlines } from './vision';

const FAPI_HOSTS = ['https://fapi.binance.com', 'https://fapi1.binance.com'];
const WS = 'wss://fstream.binance.com/market/ws';
type Row = [number, string, string, string, string, string, number, string, number, string, ...unknown[]];
export interface Stored extends KBar { closed: boolean }

export const SYMBOLS = {
  BTCUSDT: { symbol: 'BTCUSDT', name: 'BTC/USDT 무기한', label: 'BTC', pricePrecision: 1, tickSize: 0.1 },
  ETHUSDT: { symbol: 'ETHUSDT', name: 'ETH/USDT 무기한', label: 'ETH', pricePrecision: 2, tickSize: 0.01 },
} as const;
export type SymbolId = keyof typeof SYMBOLS;

export function parseSymbol(raw: string | null | undefined): SymbolId | null {
  const s = raw?.trim().toUpperCase();
  if (s === 'BTCUSDT' || s === 'BTC') return 'BTCUSDT';
  if (s === 'ETHUSDT' || s === 'ETH') return 'ETHUSDT';
  return null;
}

function historyError(symbol: string): string {
  return `${symbol} 무기한 1분봉을 불러오지 못했습니다. 이 브라우저에서 바이낸스 선물 REST가 막혀 있고, 같은 봉을 제공하는 공개 파일(data.binance.vision)도 받지 못했습니다. 네트워크를 확인한 뒤 새로고침해 주세요.`;
}

function symbolInfo(id: SymbolId): SymbolInfo {
  const s = SYMBOLS[id];
  return {
    symbol: s.symbol, name: s.name, exchange: 'Binance Futures', timezone: 'Asia/Seoul', session: '24x7',
    pricePrecision: s.pricePrecision, tickSize: s.tickSize, type: 'futures', supportedResolutions: ['1'],
  };
}

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
  symbol: SymbolId;
  /** Bumped on every symbol change so in-flight REST and sockets cannot write the other market. */
  private gen = 0;

  info: SymbolInfo;
  constructor(symbol: SymbolId = 'BTCUSDT') {
    this.symbol = symbol;
    this.info = symbolInfo(symbol);
    this.gen = 1;
  }

  /** Drop bars, sockets' writes, and the REST mode so the next load is only this symbol. */
  activate(id: SymbolId): void {
    if (id === this.symbol && this.gen > 0) return;
    this.gen++;
    this.symbol = id;
    this.info = symbolInfo(id);
    this.store.clear();
    this.maxTime = 0;
    this.lastMsg = 0;
    this.wsStatus = 'connecting';
    this.mode = 'unknown';
    this.errorMessage = '';
    this.serverSource = '';
  }

  async resolveSymbol(symbol: string): Promise<SymbolInfo> {
    const id = parseSymbol(symbol);
    if (!id) throw new Error(`unknown symbol ${symbol}`);
    this.activate(id);
    return this.info;
  }
  async searchSymbols(): Promise<SymbolInfo[]> { return [symbolInfo('BTCUSDT'), symbolInfo('ETHUSDT')]; }

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

  private failHistory(symbol: string): never {
    this.mode = 'error';
    this.errorMessage = historyError(symbol);
    this.onChange(false);
    throw new Error(this.errorMessage);
  }

  private async rows(symbol: SymbolId, gen: number, endTime: number, limit: number): Promise<Row[]> {
    const q = `symbol=${symbol}&interval=1m&limit=${limit}&endTime=${endTime}`;
    const live = () => gen === this.gen && this.symbol === symbol;
    if (this.mode !== 'vision' && this.mode !== 'server') {
      try {
        const rows = await this.direct(q);
        if (!live()) return rows;
        this.mode = 'direct';
        this.errorMessage = '';
        return rows;
      } catch (err) {
        if (this.mode === 'direct' && live()) throw err;
      }
    }
    if (!live()) return [];
    if (this.mode !== 'server') {
      try {
        const rows = await visionKlines(symbol, endTime, limit);
        if (!live()) return rows as Row[];
        this.mode = 'vision';
        this.errorMessage = '';
        return rows as Row[];
      } catch (err) {
        if (this.mode === 'vision' && live()) throw err;
      }
    }
    if (!live()) return [];
    const api = await this.tryApi(q);
    if (!live()) return api ?? [];
    if (api) {
      this.mode = 'server';
      this.errorMessage = '';
      return api;
    }
    this.failHistory(symbol);
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

  async getBars(info: SymbolInfo, _res: Resolution, req: BarsRequest): Promise<BarsResult> {
    const id = parseSymbol(info.symbol);
    if (!id) throw new Error(`unknown symbol ${info.symbol}`);
    this.activate(id);
    const gen = this.gen;
    const symbol = this.symbol;
    const wanted = req.countBack ?? Math.ceil((req.to - req.from) / 60000);
    let end = req.to, got: Row[] = [], done = false;
    while (got.length < wanted) {
      const limit = Math.min(1500, wanted - got.length);
      const rows = await this.rows(symbol, gen, end, limit);
      if (gen !== this.gen) return { bars: [], noMoreData: true };
      got = rows.concat(got);
      if (rows.length < limit || !rows[0]) { done = true; break; }
      end = rows[0][0] - 1;
    }
    if (gen !== this.gen) return { bars: [], noMoreData: true };
    this.ingest(got);
    this.onChange(true);
    const bars: Bar[] = got.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    return { bars, noMoreData: done };
  }

  /** Refetch the last bars (after a WS gap) so no closed bar is missing. */
  async heal(): Promise<void> {
    const gen = this.gen;
    const symbol = this.symbol;
    try {
      const rows = await this.rows(symbol, gen, Date.now() + 60000, 30);
      if (gen !== this.gen) return;
      this.ingest(rows);
      this.onChange(true);
    } catch { /* next bar retries */ }
  }

  subscribeBars(info: SymbolInfo, _r: Resolution, onBar: (bar: Bar) => void, onResetCache?: () => void, onConnection?: (s: ConnectionState) => void) {
    const id = parseSymbol(info.symbol) ?? this.symbol;
    const gen = this.gen;
    const stream = id.toLowerCase();
    const alive = () => gen === this.gen && this.symbol === id;
    const socket = new ReconnectingWebSocket(`${WS}/${stream}@kline_1m`, {
      idleTimeout: 30_000,
      onOpen: (_ws, reconnected) => { if (reconnected && alive()) { onResetCache?.(); void this.heal(); } },
      onStatus: (s) => { if (!alive()) return; this.wsStatus = s; onConnection?.({ status: toConnectionStatus(s) }); this.onChange(false); },
      onMessage: (text) => {
        if (!alive()) return;
        const k = (JSON.parse(text) as { k?: { t: number; o: string; h: string; l: string; c: string; v: string; V: string; x: boolean; s?: string } }).k;
        if (!k || (k.s && k.s !== id)) return;
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

  subscribeQuotes(info: SymbolInfo, onQuote: (q: Quote) => void) {
    const id = parseSymbol(info.symbol) ?? this.symbol;
    const gen = this.gen;
    const socket = new ReconnectingWebSocket(`${WS}/${id.toLowerCase()}@ticker`, {
      onMessage: (text) => {
        if (gen !== this.gen || this.symbol !== id) return;
        const d = JSON.parse(text) as Record<string, string>;
        if (d.e === '24hrTicker' && (!d.s || d.s === id)) onQuote({ price: +d.c, change: +d.p, changePercent: +d.P, high24h: +d.h, low24h: +d.l, volume24h: +d.v, turnover24h: +d.q });
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
