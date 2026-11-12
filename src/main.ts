import { createTradingChart } from '@funnest/charts-ui';
import type { Bar, ChartOverlay, IndicatorDefinition, IndicatorOutput, ObjectRenderContext } from '@funnest/charts';
import { UltraFeed, parseSymbol, SYMBOLS, type Stored, type SymbolId } from './feed';
import { BAL0, FLOW_N, FLOW_TH, PERIOD, PRESETS, features, preview, segments, simulate, type Block, type Features, type KBar, type Mark, type Preset, type SimResult, type Trade } from './engine';

// ---------- settings ----------
const LS = 'ultra-chart:v1';
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();
const urlSymbol = parseSymbol(new URLSearchParams(location.search).get('symbol'));
const ui = {
  preset: (saved.preset as string) || 'A',
  band: saved.band ?? true, preview: saved.preview ?? true, blocks: saved.blocks ?? true, labels: saved.labels ?? true, flow: saved.flow ?? true,
  symbol: (urlSymbol ?? parseSymbol(saved.symbol) ?? 'BTCUSDT') as SymbolId,
};
const persist = () => localStorage.setItem(LS, JSON.stringify(ui));
if (urlSymbol) persist();
document.title = ui.symbol === 'ETHUSDT' ? 'Ultra 차트 · ETH' : 'Ultra 차트';
const preset = (): Preset => PRESETS.find((p) => p.id === ui.preset) ?? PRESETS[1];

const C = { long: '#26a69a', short: '#ef5350', block: '#9598a1', conflict: '#ff9800', win: '#26a69a', loss: '#ef5350', text: '#d1d4dc', bg: 'rgba(19,23,34,0.85)' };

// ---------- engine state ----------
const feed = new UltraFeed(ui.symbol);
interface View { sim: SimResult | null; closed: Stored[]; forming: Stored | null; byTime: Map<number, Stored>; prev: ReturnType<typeof preview> | null; features: Features | null }
const view: View = { sim: null, closed: [], forming: null, byTime: new Map(), prev: null, features: null };

function fullFeatures(b: readonly KBar[]): Features {
  const n = b.length, mk = () => new Float64Array(n).fill(NaN);
  const F: Features = { z: mk(), sd: mk(), sma: mk(), slope: mk(), flowD: new Float64Array(n), barD: new Float64Array(n) };
  for (const [s, e] of segments(b)) {
    const f = features(b.slice(s, e));
    for (const k of Object.keys(F) as (keyof Features)[]) F[k].set(f[k], s);
  }
  return F;
}
function recompute(full: boolean): void {
  const { closed, forming } = feed.snapshot();
  if (full || !view.sim || closed.length !== view.closed.length) {
    view.closed = closed;
    view.features = closed.length ? fullFeatures(closed) : null;
    view.byTime = new Map(closed.map((b) => [b.time, b]));
  }
  view.forming = forming;
  if (forming) view.byTime.set(forming.time, forming);
  view.sim = view.features ? simulate(preset(), closed, view.features, false, forming ?? undefined) : null;
  view.prev = forming && closed.length > PERIOD && closed.at(-1)!.time === forming.time - 60000 ? preview(preset(), closed, forming) : null;
  overlay?.redraw();
  renderStats();
}
let pending = 0, needFull = false;
feed.onChange = (closedAdded) => {
  needFull ||= closedAdded;
  if (pending) return;
  pending = window.setTimeout(() => { pending = 0; const f = needFull; needFull = false; recompute(f); }, 150);
};

// ---------- indicators (Funnest IndicatorDefinition) ----------
const line = (key: string, label: string, values: Float64Array, color: string, width = 1) => ({ key, label, values, color, width, visible: true, kind: 'line' as const });
const bandDef: IndicatorDefinition = {
  type: 'ultraBand', name: { ko: 'Ultra 밴드 (SMA20 ± kσ)', en: 'Ultra band' }, description: { ko: 'SMA20 ± k·σ(모집단), k는 프리셋 값', en: 'SMA20 ± k·σ' },
  overlay: true, hidden: true, params: [{ key: 'k', label: { ko: 'k', en: 'k' }, kind: 'number', min: 0.5, max: 5, step: 0.1 }], defaults: { k: 2.5 },
  title: (p) => `Ultra 밴드 20 ±${Number(p.k)}σ`,
  compute: (bars: readonly Bar[], p): IndicatorOutput => {
    const n = bars.length, k = Number(p.k), mid = new Float64Array(n).fill(NaN), up = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN);
    for (let i = PERIOD - 1; i < n; i++) {
      if (bars[i].time - bars[i - PERIOD + 1].time !== (PERIOD - 1) * 60000) continue; // window spans a data gap
      let s = 0; for (let j = i - PERIOD + 1; j <= i; j++) s += bars[j].close;
      const m = s / PERIOD; let v = 0; for (let j = i - PERIOD + 1; j <= i; j++) v += (bars[j].close - m) ** 2;
      const sd = Math.sqrt(v / PERIOD); mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
    }
    return { series: [line('up', '상단', up, '#2962ff'), line('mid', 'SMA20', mid, '#ff9800'), line('lo', '하단', lo, '#2962ff')], fill: { upper: 'up', lower: 'lo', color: '#2962ff' }, precision: null };
  },
};
const flowDef: IndicatorDefinition = {
  type: 'ultraFlow', name: { ko: '매수·매도 거래량 흐름', en: 'Taker flow' }, description: { ko: '봉별 (매수-매도)/거래량 막대 + D20 선, 기준 ±0.104', en: '' },
  overlay: false, hidden: true, params: [], defaults: {},
  title: () => `거래량 흐름 · 막대 (매수-매도)/거래량 · 선 D${FLOW_N} (±${FLOW_TH.toFixed(3)})`,
  compute: (bars: readonly Bar[]): IndicatorOutput => {
    const n = bars.length, h = new Float64Array(n).fill(NaN), d = new Float64Array(n).fill(NaN);
    let sd = 0, sv = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0 && bars[i].time - bars[i - 1].time !== 60000) { sd = 0; sv = 0; cnt = 0; } // restart after a gap
      const s = feed.store.get(bars[i].time), v = s?.volume ?? bars[i].volume ?? 0, dr = s ? 2 * s.takerBuy - s.volume : NaN;
      if (dr === dr && v > 0) h[i] = dr / v;
      // D20 shown = backtest formula (sum over last 20 bars incl. this one); NaN where taker data is missing
      sd += dr === dr ? dr : 0; sv += v; cnt++;
      if (cnt > FLOW_N) { const o = feed.store.get(bars[i - FLOW_N].time); sd -= o ? 2 * o.takerBuy - o.volume : 0; sv -= o?.volume ?? bars[i - FLOW_N].volume ?? 0; cnt--; }
      if (cnt >= FLOW_N && sv > 0) d[i] = sd / sv;
    }
    return { series: [{ ...line('bar', '봉 델타', h, ''), kind: 'histogram' }, line('d20', 'D20', d, '#ffd166', 1.5)], levels: [-FLOW_TH, 0, FLOW_TH], precision: 3 };
  },
};

// ---------- chart ----------
const app = document.getElementById('app')!;
const narrow = window.innerWidth < 640;
const tc = createTradingChart(document.getElementById('chart')!, {
  datafeed: feed, symbol: ui.symbol, resolution: '1', favoriteIntervals: ['1'], intervalGroups: [{ id: 'minutes', intervals: ['1'] }],
  locale: 'ko', colorScheme: 'dark', direction: 'global', displayTimezone: 'Asia/Seoul', drawingToolbar: !narrow,
  historyBatchSize: 3000, volume: false, indicatorDefinitions: [bandDef, flowDef], storageKey: 'ultra-chart-fc',
  attribution: true, // funnest-charts Apache-2.0 badge; leave this on
});
const chart = tc.chart;
// Room under lows and above highs so the entry arrow and pill stay inside the price pane.
const mainScale = (chart as unknown as { mainScale: { margins: { top: number; bottom: number } } }).mainScale;
mainScale.margins.top = 0.24;
mainScale.margins.bottom = 0.32;
let bandId: string | null = null, flowId: string | null = null;
function syncIndicators() {
  for (const c of chart.getIndicators()) if (c.type === 'ultraBand' || c.type === 'ultraFlow') chart.removeIndicator(c.id);
  bandId = ui.band ? chart.addIndicator('ultraBand', { k: preset().k }) : null;
  flowId = ui.flow ? chart.addIndicator('ultraFlow', {}) : null;
}
syncIndicators();

// ---------- overlay: signals, entries, exits ----------
const WHY: Record<Trade['reason'], string> = { TP: '익절', SL: '손절', T: '시간', LIQ: '청산', OPEN: '보유' };
const BLK: Record<Block, string> = { trend: '추세', vol: '변동성', flow: '거래량' };
const pct = (r: number) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`;

function tri(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, up: boolean, fill: string | null, stroke?: string) {
  ctx.beginPath();
  if (up) { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8); }
  else { ctx.moveTo(x, y + s); ctx.lineTo(x + s, y - s * 0.8); ctx.lineTo(x - s, y - s * 0.8); }
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
}
function tag(rc: ObjectRenderContext, s: string, x: number, y: number, color: string, above: boolean) {
  const { painter } = rc, w = painter.measure(s) + 8, h = 15, yy = above ? y - h : y;
  painter.roundRect(x - w / 2, yy, w, h, 3, C.bg);
  painter.text(s, x, yy + h / 2 + 0.5, color, 'center', 'middle');
}
/** Bold arrow. `tipY` is the point; the shaft runs away from the bar. */
function entryArrow(ctx: CanvasRenderingContext2D, x: number, tipY: number, up: boolean, color: string, len: number) {
  const head = len * 0.62, headW = len * 1.05, shaftW = Math.max(8, len * 0.44);
  const neck = head * 0.7;
  ctx.beginPath();
  if (up) {
    const tail = tipY + len;
    ctx.moveTo(x, tipY);
    ctx.lineTo(x + headW / 2, tipY + head);
    ctx.lineTo(x + shaftW / 2, tipY + neck);
    ctx.lineTo(x + shaftW / 2, tail);
    ctx.lineTo(x - shaftW / 2, tail);
    ctx.lineTo(x - shaftW / 2, tipY + neck);
    ctx.lineTo(x - headW / 2, tipY + head);
  } else {
    const tail = tipY - len;
    ctx.moveTo(x, tipY);
    ctx.lineTo(x + headW / 2, tipY - head);
    ctx.lineTo(x + shaftW / 2, tipY - neck);
    ctx.lineTo(x + shaftW / 2, tail);
    ctx.lineTo(x - shaftW / 2, tail);
    ctx.lineTo(x - shaftW / 2, tipY - neck);
    ctx.lineTo(x - headW / 2, tipY - head);
  }
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0b0e14';
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
}
function entryPill(rc: ObjectRenderContext, text: string, x: number, anchorY: number, bg: string, above: boolean) {
  const { painter } = rc;
  painter.ctx.font = 'bold 13px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", NanumGothic, sans-serif';
  const w = painter.measure(text) + 18, h = 22, y = above ? anchorY - h : anchorY;
  painter.roundRect(x - w / 2, y, w, h, h / 2, bg);
  painter.text(text, x, y + h / 2 + 0.5, '#ffffff', 'center', 'middle');
}

const ultraOverlay: ChartOverlay = {
  render(rc) {
    const sim = view.sim; if (!sim) return;
    const { painter, coords } = rc, ctx = painter.ctx;
    const lastT = view.closed.at(-1)?.time ?? 0;
    const spRaw = Math.abs(coords.timeToX(lastT) - coords.timeToX(lastT - 60000));
    const sp = Number.isFinite(spRaw) ? spRaw : 0;
    const S = Math.max(3.5, Math.min(7, sp * 0.7)), labels = ui.labels && sp >= 3, W = coords.plotWidth;
    const vis = (x: number) => x > -40 && x < W + 40;
    ctx.save(); ctx.font = '11px -apple-system, "Noto Sans KR", sans-serif';
    const hiLo = (t: number) => view.byTime.get(t);

    // confirmed entries: big arrow always, pill unless bars are extremely compressed.
    // Independent of the 청산라벨 toggle.
    const drawEntry = (m: { time: number; side: number }) => {
      const b = hiLo(m.time); if (!b) return;
      const x = coords.timeToX(m.time); if (x < -24 || x > W + 24) return;
      const long = m.side > 0;
      const len = Math.max(32, Math.min(46, sp * 2.4));
      const gap = 3;
      if (long) {
        const tip = coords.priceToY(b.low) + gap;
        entryArrow(ctx, x, tip, true, C.long, len);
        if (sp >= 3) entryPill(rc, '롱 진입', x, tip + len + 3, '#0e7c68', false);
      } else {
        const tip = coords.priceToY(b.high) - gap;
        entryArrow(ctx, x, tip, false, C.short, len);
        if (sp >= 3) entryPill(rc, '숏 진입', x, tip - len - 3, '#d32f2f', true);
      }
    };

    if (sp < 0.6) {
      for (const m of sim.marks) if (m.kind === 'signal') drawEntry(m);
      ctx.restore();
      return;
    }

    // block / conflict marks (confirmed signals are drawn last, on top)
    const drawMark = (m: { time: number; side: number; kind: Mark['kind'] | 'preview' | 'previewBlock'; block?: Block | null }) => {
      const b = hiLo(m.time); if (!b) return;
      const x = coords.timeToX(m.time); if (!vis(x)) return;
      const long = m.side > 0, y = long ? coords.priceToY(b.low) + S + 4 : coords.priceToY(b.high) - S - 4;
      if (m.kind === 'preview') { ctx.globalAlpha = 0.45; tri(ctx, x, y, S, long, long ? C.long : C.short, long ? C.long : C.short); ctx.globalAlpha = 1; if (labels) tag(rc, '예비', x, long ? y + S + 2 : y - S - 2, long ? C.long : C.short, !long); }
      else if (m.kind === 'block' || m.kind === 'previewBlock') {
        ctx.globalAlpha = m.kind === 'previewBlock' ? 0.45 : 0.8; tri(ctx, x, y, S * 0.8, long, null, C.block); ctx.globalAlpha = 1;
        if (labels && sp >= 5) tag(rc, `차단·${BLK[m.block!]}`, x, long ? y + S + 2 : y - S - 2, C.block, !long);
      } else if (m.kind === 'conflict') {
        ctx.beginPath(); ctx.moveTo(x, y - S); ctx.lineTo(x + S, y); ctx.lineTo(x, y + S); ctx.lineTo(x - S, y); ctx.closePath();
        ctx.fillStyle = C.conflict; ctx.fill();
        if (labels) tag(rc, '충돌', x, long ? y + S + 2 : y - S - 2, C.conflict, !long);
      }
    };
    for (const m of sim.marks) if (m.kind !== 'signal' && ui.blocks) drawMark(m);

    // trades: dashed entry→exit, entry dot, exit X + reason label
    const drawTrade = (t: Trade) => {
      const x1 = coords.timeToX(t.entryTime), x2 = coords.timeToX(t.exitTime);
      if (Math.max(x1, x2) < -40 || Math.min(x1, x2) > W + 40) return;
      const y1 = coords.priceToY(t.rawEntry), y2 = coords.priceToY(t.rawExit);
      const col = t.reason === 'OPEN' ? '#ffd166' : t.pnl > 0 ? C.win : C.loss;
      painter.line(x1, y1, x2, y2, col, 1.2, [4, 3]);
      painter.circle(x1, y1, Math.max(2.5, S * 0.55), t.side > 0 ? C.long : C.short, '#ffffff', 1);
      if (t.reason === 'OPEN') { if (labels) tag(rc, `보유 ${t.side > 0 ? '롱' : '숏'} ${pct(t.ret)}`, x2 + 30, y2 - 8, col, false); return; }
      const r = Math.max(3, S * 0.6);
      painter.line(x2 - r, y2 - r, x2 + r, y2 + r, col, 2); painter.line(x2 - r, y2 + r, x2 + r, y2 - r, col, 2);
      if (labels) tag(rc, `${WHY[t.reason]} ${pct(t.ret)}`, x2, t.side > 0 ? y2 - r - 2 : y2 + r + 2, col, t.side > 0);
    };
    for (const t of sim.trades) drawTrade(t);
    if (sim.open) drawTrade(sim.open);

    // preview on the forming bar
    if (ui.preview && view.forming && view.prev && view.prev.side) {
      if (!view.prev.block) drawMark({ time: view.forming.time, side: view.prev.side, kind: 'preview' });
      else if (ui.blocks) drawMark({ time: view.forming.time, side: view.prev.side, kind: 'previewBlock', block: view.prev.block });
    }
    ctx.font = '11px -apple-system, "Noto Sans KR", sans-serif';
    for (const m of sim.marks) if (m.kind === 'signal') drawEntry(m);
    ctx.restore();
  },
};
const overlay = chart.addOverlay(ultraOverlay);

// ---------- controls + stats ----------
const bar = document.createElement('div'); bar.className = 'ux-bar';
const banner = document.createElement('div'); banner.className = 'ux-banner';
const seg = document.createElement('div'); seg.className = 'ux-seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', '종목');
const symBtns = {} as Record<SymbolId, HTMLButtonElement>;
function paintSymbol() {
  for (const id of Object.keys(symBtns) as SymbolId[]) symBtns[id].classList.toggle('on', id === ui.symbol);
  for (const id of Object.keys(symBtns) as SymbolId[]) symBtns[id].setAttribute('aria-pressed', id === ui.symbol ? 'true' : 'false');
}
async function selectSymbol(id: SymbolId) {
  if (id === ui.symbol && feed.symbol === id) return;
  ui.symbol = id;
  persist();
  const url = new URL(location.href);
  url.searchParams.set('symbol', id);
  history.replaceState(null, '', url);
  document.title = id === 'ETHUSDT' ? 'Ultra 차트 · ETH' : 'Ultra 차트';
  paintSymbol();
  view.sim = null; view.closed = []; view.forming = null; view.byTime = new Map(); view.prev = null; view.features = null;
  needFull = true;
  overlay?.redraw();
  renderStats();
  await chart.setSymbol(id, '1');
}
for (const id of ['BTCUSDT', 'ETHUSDT'] as const) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = SYMBOLS[id].label;
  b.onclick = () => { void selectSymbol(id); };
  symBtns[id] = b;
  seg.appendChild(b);
}
paintSymbol();
bar.appendChild(seg);
const sel = document.createElement('select');
for (const p of PRESETS) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); }
sel.value = preset().id;
sel.onchange = () => { ui.preset = sel.value; persist(); syncIndicators(); recompute(true); };
bar.appendChild(sel);
const chips: [keyof typeof ui, string][] = [['band', '밴드'], ['preview', '예비신호'], ['blocks', '차단·충돌'], ['labels', '청산라벨'], ['flow', '거래량흐름']];
for (const [key, label] of chips) {
  const c = document.createElement('span'); c.className = 'ux-chip' + (ui[key] ? ' on' : ''); c.textContent = label;
  c.onclick = () => { (ui as Record<string, unknown>)[key] = !ui[key]; c.classList.toggle('on', !!ui[key]); persist(); if (key === 'band' || key === 'flow') syncIndicators(); overlay.redraw(); };
  bar.appendChild(c);
}
const stats = document.createElement('span'); stats.className = 'ux-stats';
const status = document.createElement('span'); status.className = 'ux-status mut';
tc.slots.belowToolbar.appendChild(bar);
if (narrow) { // phone: stats + status on their own row so they are visible without scrolling
  const row = document.createElement('div'); row.className = 'ux-bar'; row.append(stats, status); tc.slots.belowToolbar.appendChild(row);
} else bar.append(stats, status);
tc.slots.belowToolbar.appendChild(banner);

const fmtT = (t: number) => new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function renderStats() {
  if (feed.mode === 'error') {
    stats.textContent = '데이터를 불러오지 못했습니다';
    status.innerHTML = '<span class="neg">● 시세 없음</span>';
    banner.classList.add('bad');
    banner.style.display = 'block';
    banner.textContent = feed.errorMessage;
    return;
  }
  const s = view.sim, p = preset();
  if (!s) { stats.textContent = '불러오는 중…'; return; }
  const eq = s.cash + (s.open ? s.open.margin + s.open.pnl : 0), ret = eq / BAL0 - 1, wr = s.n ? s.wins / s.n : 0;
  const first = view.closed[0]?.time;
  stats.innerHTML = `<span class="mut">${SYMBOLS[feed.symbol].label} · ${p.name} · $600 · 4%×50</span> 거래 <b>${s.n}</b> 승률 <b>${(wr * 100).toFixed(1)}%</b> 수익 <b class="${ret >= 0 ? 'pos' : 'neg'}">${pct(ret)}</b> <span class="mut">MDD ${(s.maxDD * 100).toFixed(1)}%</span>` +
    (s.open ? ` <span class="${s.open.ret >= 0 ? 'pos' : 'neg'}">보유 ${s.open.side > 0 ? '롱' : '숏'} ${pct(s.open.ret)}</span>` : '') +
    (first ? ` <span class="mut">${fmtT(first)}~ (${view.closed.length}봉)</span>` : '');
  const ago = feed.lastMsg ? Math.round((Date.now() - feed.lastMsg) / 1000) : null;
  const live = feed.wsStatus === 'open' && ago !== null && ago < 10;
  const src = feed.mode === 'vision' ? '공개파일' : feed.mode === 'server' ? '대체경로' : '바이낸스';
  status.innerHTML = `${live ? '<span class="pos">● 실시간</span>' : '<span class="neg">● 연결 중</span>'} · ${src}${view.prev ? ` · z ${view.prev.z.toFixed(2)} · D20 ${view.prev.d.toFixed(3)}` : ''}`;
  const gaps = Math.max(0, segments(view.closed).length - 1);
  banner.classList.remove('bad');
  if (feed.mode === 'vision') {
    banner.style.display = 'block';
    banner.textContent = `바이낸스 선물 REST에 연결하지 못해, 같은 ${feed.symbol} 무기한 1분봉(테이커 매수량 포함)을 공개 파일(data.binance.vision)로 표시합니다. 파일은 보통 다음 날 올라와 오늘 구간이 비어 있을 수 있습니다.${gaps ? ` 공백 ${gaps}곳 뒤 지표는 다시 워밍업됩니다.` : ''} 실시간 봉은 WebSocket이 연결되면 이어집니다.`;
  } else if (feed.mode === 'server') {
    banner.style.display = 'block';
    banner.textContent = '바이낸스 REST와 공개 데이터 파일을 받지 못해 /api/klines 응답으로 표시합니다.';
  } else {
    banner.style.display = 'none';
    banner.textContent = '';
  }
}
setInterval(renderStats, 1000);
window.addEventListener('resize', () => overlay.redraw());

// debug / parity hook (read only)
(window as unknown as Record<string, unknown>).__ultra = {
  feed, view, PRESETS, chart,
  setPreset: (id: string) => { sel.value = id; sel.onchange?.(new Event("change")); },
  setSymbol: (id: string) => selectSymbol(parseSymbol(id) ?? 'BTCUSDT'),
  dumpBars: () => feed.snapshot().closed.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume, b.takerBuy]),
  trades: (id = 'A') => { const p = PRESETS.find((x) => x.id === id)!; const b = feed.snapshot().closed; return simulate(p, b, fullFeatures(b), true).trades; },
};
void app;
