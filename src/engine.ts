// Ultra z-fade signal + paper-trade engine for the chart (display only, no orders).
// Mirrors /workspace/backtest/wr65/k.py (run, zarr), /workspace/backtest/volflow/feat.py and
// /workspace/ultra-v5/bot/engine.py. Float math emulates numpy (pairwise sum) and pandas
// (Kahan rolling) so signals match the Python backtest bar for bar.

export interface KBar { time: number; open: number; high: number; low: number; close: number; volume: number; takerBuy: number }

export interface Preset {
  id: string; name: string;
  k: number; tpPct: number; slPct: number; bars: number;
  trend: boolean; volMin: number | null; flow: boolean;
}

export const VOL_MIN = 0.0009951267;
/** |D20| median on the in-sample split (volflow/final.py: real_N20_exhaust_q0.5, printed as 0.104). */
export const FLOW_TH = 0.1035743857100149;
export const TREND_N = 1200, TREND_LB = 60, PERIOD = 20, FLOW_N = 20;
export const SLIP = 2e-5, LEV = 50, MMR = 0.005, BAL0 = 600, PCT = 0.04;

export const PRESETS: Preset[] = [
  { id: 'orig', name: '원본', k: 2.0, tpPct: 0.30, slPct: 0.15, bars: 15, trend: false, volMin: null, flow: false },
  { id: 'A', name: '고승률A', k: 2.5, tpPct: 0.15, slPct: 1.0, bars: 30, trend: true, volMin: VOL_MIN, flow: false },
  { id: 'Aflow', name: '고승률A+거래량', k: 2.5, tpPct: 0.15, slPct: 1.0, bars: 30, trend: true, volMin: VOL_MIN, flow: true },
];

// ---------- numpy / pandas float emulation ----------
/** numpy pairwise_sum for n <= 128 (unrolled by 8). */
function pairwise(a: ArrayLike<number>, s: number, n: number): number {
  if (n < 8) { let r = -0; for (let i = 0; i < n; i++) r += a[s + i]; return r; }
  const r = [a[s], a[s + 1], a[s + 2], a[s + 3], a[s + 4], a[s + 5], a[s + 6], a[s + 7]];
  let i = 8;
  for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[s + i + j];
  let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
  for (; i < n; i++) res += a[s + i];
  return res;
}
/** np.add.reduce over a contiguous row: first element, then pairwise over the rest. */
function npSum(a: ArrayLike<number>, s: number, n: number): number { return a[s] + pairwise(a, s + 1, n - 1); }

/** pandas Series.rolling(w).mean() / .sum() (Kahan add/remove, pandas 2.x/3.x window aggregations). */
function pdRolling(x: ArrayLike<number>, w: number, mean: boolean): Float64Array {
  const n = x.length, out = new Float64Array(n).fill(NaN);
  let nobs = 0, sum = 0, cAdd = 0, cRem = 0, negCt = 0, prev = NaN, same = 0;
  const add = (v: number) => {
    if (v !== v) return;
    nobs++; const y = v - cAdd, t = sum + y; cAdd = t - sum - y; sum = t;
    if (v < 0 || Object.is(v, -0)) negCt++;
    if (v === prev) same++; else same = 1;
    prev = v;
  };
  const rem = (v: number) => {
    if (v !== v) return;
    nobs--; const y = -v - cRem, t = sum + y; cRem = t - sum - y; sum = t;
    if (v < 0 || Object.is(v, -0)) negCt--;
  };
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i + 1 - w), e = i + 1;
    if (i === 0) { prev = x[0]; same = 0; for (let j = s; j < e; j++) add(x[j]); }
    else {
      const ps = Math.max(0, i - w);
      for (let j = ps; j < s; j++) rem(x[j]);
      add(x[e - 1]);
    }
    if (nobs >= w) {
      if (mean) {
        let r = sum / nobs;
        if (same >= nobs) r = prev; else if (negCt === 0 && r < 0) r = 0; else if (negCt === nobs && r > 0) r = 0;
        out[i] = r;
      } else out[i] = same >= nobs ? prev * nobs : sum;
    }
  }
  return out;
}

export interface Features {
  z: Float64Array; sd: Float64Array; sma: Float64Array; slope: Float64Array; flowD: Float64Array; barD: Float64Array;
}

/** Indicators on a contiguous block of bars (index-based like the backtest). */
export function features(b: readonly KBar[]): Features {
  const n = b.length, c = Float64Array.from(b, (x) => x.close);
  const z = new Float64Array(n).fill(NaN), sd = new Float64Array(n).fill(NaN), sma = new Float64Array(n).fill(NaN);
  const tmp = new Float64Array(PERIOD);
  for (let i = PERIOD - 1; i < n; i++) {
    const s = i - PERIOD + 1, m = npSum(c, s, PERIOD) / PERIOD;
    for (let j = 0; j < PERIOD; j++) { const d = c[s + j] - m; tmp[j] = d * d; }
    const v = Math.sqrt(npSum(tmp, 0, PERIOD) / PERIOD);
    sma[i] = m; sd[i] = v;
    const ok = b[i].time - b[s].time === (PERIOD - 1) * 60000;
    z[i] = ok && v > 0 ? (c[i] - m) / v : NaN;
  }
  const s1200 = pdRolling(c, TREND_N, true), slope = new Float64Array(n).fill(NaN);
  for (let i = TREND_N + TREND_LB; i < n; i++) slope[i] = s1200[i] - s1200[i - TREND_LB];
  const dr = Float64Array.from(b, (x) => 2 * x.takerBuy - x.volume), v = Float64Array.from(b, (x) => x.volume);
  const sdr = pdRolling(dr, FLOW_N, false), sv = pdRolling(v, FLOW_N, false);
  const flowD = new Float64Array(n), barD = new Float64Array(n);
  for (let i = 0; i < n; i++) { flowD[i] = sv[i] > 0 ? sdr[i] / sv[i] : 0; barD[i] = v[i] > 0 ? dr[i] / v[i] : 0; }
  return { z, sd, sma, slope, flowD, barD };
}

export type Block = 'trend' | 'vol' | 'flow';
/** Raw z side (+1 long / -1 short / 0) and the first filter that blocks it. */
export function judge(p: Preset, F: Features, c: number, i: number): { side: number; block: Block | null } {
  const zi = F.z[i]; let s = 0;
  if (zi === zi) { if (zi < -p.k) s = 1; else if (zi > p.k) s = -1; }
  if (!s) return { side: 0, block: null };
  if (p.trend) { const sl = F.slope[i]; if (!(s > 0 ? sl > 0 : sl < 0)) return { side: s, block: 'trend' }; }
  if (p.volMin != null) { if (!(F.sd[i] / c >= p.volMin)) return { side: s, block: 'vol' }; }
  if (p.flow) { const d = F.flowD[i]; if (!(s > 0 ? d < -FLOW_TH : d > FLOW_TH)) return { side: s, block: 'flow' }; }
  return { side: s, block: null };
}

export interface Trade {
  side: number; sigIdx: number; entryIdx: number; exitIdx: number; entryTime: number; exitTime: number;
  rawEntry: number; rawExit: number; reason: 'TP' | 'SL' | 'T' | 'LIQ' | 'OPEN'; ret: number; pnl: number; margin: number; cashAfter: number;
}
export interface Mark { idx: number; time: number; side: number; kind: 'signal' | 'block' | 'conflict'; block?: Block }
export interface SimResult {
  trades: Trade[]; marks: Mark[]; cash: number; wins: number; n: number; maxDD: number; open: Trade | null;
}

/**
 * k.run on bars[0..N). backtestEnd=true reproduces the backtest's end rules exactly
 * (entries need i+T<=N, signals need i+1<N); false = live chart (the last signal enters the forming bar).
 */
export function simulate(p: Preset, b: readonly KBar[], F: Features, backtestEnd: boolean, forming?: KBar): SimResult {
  const N = b.length, T = p.bars, tp = p.tpPct / 100, sl = p.slPct / 100, liq = 1 / LEV - MMR;
  let cash = BAL0, peak = BAL0, mdd = 0, n = 0, w = 0, pend = 0, pendSig = -1;
  let inpos = false, side = 0, e0 = 0, op = 0, tpp = 0, slp = 0, mg = 0, sigI = -1;
  const trades: Trade[] = [], marks: Mark[] = [];
  const close = (i: number, raw: number, why: Trade['reason']) => {
    const en = op * (1 + side * SLIP), ex = raw * (1 - side * SLIP); let r = side * (ex - en) / en;
    if (r <= -liq) { r = -1 / LEV; why = 'LIQ'; }
    const pnl = mg * LEV * r; cash += mg + pnl; inpos = false; n++; if (pnl > 0) w++;
    if (cash > peak) peak = cash; const dd = (peak - cash) / peak; if (dd > mdd) mdd = dd;
    trades.push({ side, sigIdx: sigI, entryIdx: e0, exitIdx: i, entryTime: b[e0].time, exitTime: b[i].time, rawEntry: op, rawExit: raw, reason: why, ret: r, pnl, margin: mg, cashAfter: cash });
  };
  const enter = (i: number, open: number) => {
    let m = PCT * cash; if (m > cash) m = cash;
    if (m >= 1) {
      side = pend; e0 = i; op = open; mg = m; inpos = true; sigI = pendSig;
      if (side > 0) { tpp = op * (1 + tp); slp = op * (1 - sl); } else { tpp = op * (1 - tp); slp = op * (1 + sl); }
      cash -= mg;
    }
  };
  for (let i = 0; i < N; i++) {
    const x = b[i];
    if (pend !== 0 && !inpos) { if (!backtestEnd || i + T <= N) enter(i, x.open); pend = 0; }
    if (inpos) {
      let raw = -1, why: Trade['reason'] = 'T';
      if (side > 0) { if (x.low <= slp) { raw = Math.min(slp, x.open); why = 'SL'; } else if (x.high >= tpp) { raw = tpp; why = 'TP'; } }
      else { if (x.high >= slp) { raw = Math.max(slp, x.open); why = 'SL'; } else if (x.low <= tpp) { raw = tpp; why = 'TP'; } }
      if (raw < 0 && i - e0 + 1 >= T) { raw = x.close; why = 'T'; }
      if (raw > 0) close(i, raw, why);
    }
    const j = judge(p, F, x.close, i);
    if (j.side) {
      if (!inpos) {
        if (!backtestEnd || i + 1 < N) {
          if (j.block) marks.push({ idx: i, time: x.time, side: j.side, kind: 'block', block: j.block });
          else { marks.push({ idx: i, time: x.time, side: j.side, kind: 'signal' }); pend = j.side; pendSig = i; }
        }
      } else if (!j.block && j.side !== side) marks.push({ idx: i, time: x.time, side: j.side, kind: 'conflict' });
    }
  }
  let open: Trade | null = null;
  if (!backtestEnd && forming) {
    if (pend !== 0 && !inpos) { enter(N, forming.open); pend = 0; if (inpos) e0 = N; }
    if (inpos) {
      const en = op * (1 + side * SLIP), ex = forming.close * (1 - side * SLIP), r = side * (ex - en) / en;
      open = { side, sigIdx: sigI, entryIdx: e0, exitIdx: N, entryTime: e0 < N ? b[e0].time : forming.time, exitTime: forming.time, rawEntry: op, rawExit: forming.close, reason: 'OPEN', ret: r, pnl: mg * LEV * r, margin: mg, cashAfter: cash };
    }
  } else if (!backtestEnd && inpos) {
    open = { side, sigIdx: sigI, entryIdx: e0, exitIdx: N - 1, entryTime: b[e0].time, exitTime: b[N - 1].time, rawEntry: op, rawExit: b[N - 1].close, reason: 'OPEN', ret: 0, pnl: 0, margin: mg, cashAfter: cash };
  }
  return { trades, marks, cash, wins: w, n, maxDD: mdd, open };
}

/** Preview on the forming bar: same rules with the forming close appended. */
export function preview(p: Preset, b: readonly KBar[], forming: KBar): { side: number; block: Block | null; z: number; d: number } {
  const tail = b.slice(-(TREND_N + TREND_LB + 5)).concat([forming]);
  const F = features(tail), i = tail.length - 1, j = judge(p, F, forming.close, i);
  return { ...j, z: F.z[i], d: F.flowD[i] };
}

/** Split into contiguous 1m runs; indicators restart after a gap (the bot needs contiguous bars). */
export function segments(b: readonly KBar[]): [number, number][] {
  const out: [number, number][] = []; let s = 0;
  for (let i = 1; i <= b.length; i++) if (i === b.length || b[i].time - b[i - 1].time !== 60000) { out.push([s, i]); s = i; }
  return out;
}
