// <tf-bar-chart unit="tokens|usd|count" height="240" first-col="Day"
//   labels='["Oct 19","Oct 20"]'
//   series='[{"name":"Claude","model":"claude","color":"chart-1","values":[1.2,0.8]}]'
//   caption="Tokens per day by model">
// Stacked columns, one per label. Bars cap at 24px, 2px surface gap between segments,
// rounded top end only. Hover a column for the breakdown. "Table" swaps to a data table.
const TF_CLOGO = { claude: 'claude-color', codex: 'codex-color', deepseek: 'deepseek-color', gemini: 'gemini-color', qwen: 'qwen-color', openai: 'openai' };
const tfFmt = (v, unit) => unit === 'usd' ? '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2))
  : unit === 'count' ? String(Math.round(v))
  : (v >= 1 ? v.toFixed(v >= 10 ? 0 : 1) + 'M' : Math.round(v * 1000) + 'K');
let tfChartSeq = 0;
class TfBarChart extends HTMLElement {
  connectedCallback() {
    if (this._wired) return; this._wired = true;
    const go = () => { this.setup(); new ResizeObserver(() => this.draw()).observe(this.querySelector('[data-c="plot"]')); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
  }
  setup() {
    this.labels = JSON.parse(this.getAttribute('labels') || '[]');
    this.series = JSON.parse(this.getAttribute('series') || '[]');
    this.unit = this.getAttribute('unit') || 'tokens';
    this.h = +(this.getAttribute('height') || 240);
    this.uid = 'tfc' + (++tfChartSeq);
    const cap = this.getAttribute('caption') || 'Chart';
    const firstCol = this.getAttribute('first-col') || 'Day';
    this.className = 'block';
    this.innerHTML = `
      <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <ul class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
          ${this.series.map((s) => '<li class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-sm" style="background:var(--' + s.color + ')"></span>' + (TF_CLOGO[s.model] ? '<img alt="" class="size-3.5" src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.101.0/icons/' + TF_CLOGO[s.model] + '.svg">' : '') + '<span class="text-foreground">' + s.name + '</span></li>').join('')}
        </ul>
        <div class="ml-auto inline-flex rounded-md border border-border p-0.5 text-xs" role="tablist" aria-label="Chart view">
          <button role="tab" aria-selected="true" data-v="chart" class="rounded bg-accent px-2 py-0.5 font-medium text-accent-foreground">Chart</button>
          <button role="tab" aria-selected="false" data-v="table" class="rounded px-2 py-0.5 text-muted-foreground hover:text-foreground">Table</button>
        </div>
      </div>
      <div data-c="plot" class="relative w-full" style="height:${this.h}px" role="img" aria-label="${cap}"></div>
      <div data-c="table" class="hidden max-h-72 overflow-auto rounded-lg border border-border">
        <table class="w-full text-sm"><caption class="sr-only">${cap}</caption>
          <thead class="sticky top-0 bg-muted text-xs text-muted-foreground"><tr><th class="px-3 py-2 text-left font-medium">${firstCol}</th>${this.series.map((s) => '<th class="px-3 py-2 text-right font-medium">' + s.name + '</th>').join('')}<th class="px-3 py-2 text-right font-medium">Total</th></tr></thead>
          <tbody>${this.labels.map((l, i) => '<tr class="border-t border-border"><td class="px-3 py-1.5">' + l + '</td>' + this.series.map((s) => '<td class="px-3 py-1.5 text-right tabular-nums">' + tfFmt(s.values[i] || 0, this.unit) + '</td>').join('') + '<td class="px-3 py-1.5 text-right font-medium tabular-nums">' + tfFmt(this.series.reduce((a, s) => a + (s.values[i] || 0), 0), this.unit) + '</td></tr>').join('')}</tbody>
        </table>
      </div>`;
    this.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.v === 'table';
      this.querySelector('[data-c="plot"]').classList.toggle('hidden', t);
      this.querySelector('[data-c="table"]').classList.toggle('hidden', !t);
      this.querySelectorAll('[data-v]').forEach((x) => { const on = x === b; x.setAttribute('aria-selected', on); x.className = 'rounded px-2 py-0.5 ' + (on ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:text-foreground'); });
    }));
  }
  draw() {
    const plot = this.querySelector('[data-c="plot"]');
    const W = plot.clientWidth; if (!W) return;
    const H = this.h, padL = 44, padB = 22, padT = 8, iw = W - padL - 4, ih = H - padB - padT;
    const totals = this.labels.map((_, i) => this.series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const raw = Math.max(...totals, 0.0001);
    let top;
    if (this.unit === 'count') top = Math.max(3, Math.ceil(raw / 3) * 3);
    else { const step = Math.pow(10, Math.floor(Math.log10(raw))); top = Math.ceil(raw / step) * step; }
    const n = this.labels.length, band = iw / n, bw = Math.min(24, band * 0.62);
    const y = (v) => padT + ih - (v / top) * ih;
    let grid = '';
    for (let k = 0; k <= 3; k++) { const v = (top / 3) * k; const yy = y(v);
      grid += '<line x1="' + padL + '" x2="' + (W - 4) + '" y1="' + yy + '" y2="' + yy + '" style="stroke:var(--border)" stroke-width="1" ' + (k ? 'stroke-dasharray="2 3"' : '') + '/>' +
        '<text x="' + (padL - 8) + '" y="' + (yy + 4) + '" text-anchor="end" style="fill:var(--muted-foreground);font-size:11px;font-variant-numeric:tabular-nums">' + tfFmt(v, this.unit) + '</text>'; }
    let bars = '', clips = '', xl = '', hits = '';
    const every = Math.ceil(n / Math.max(2, Math.floor(iw / 56)));
    this.labels.forEach((l, i) => {
      const x = padL + band * i + (band - bw) / 2;
      const yt = y(totals[i]);
      clips += '<clipPath id="' + this.uid + 'c' + i + '"><rect x="' + x + '" y="' + yt + '" width="' + bw + '" height="' + (padT + ih - yt + 6) + '" rx="4"/></clipPath>';
      let acc = 0, segs = '';
      this.series.forEach((s, si) => { const v = s.values[i] || 0; if (!v) return;
        const y1 = y(acc + v), y0 = y(acc); acc += v;
        const gap = si === 0 ? 0 : 2;
        segs += '<rect x="' + x + '" y="' + y1 + '" width="' + bw + '" height="' + Math.max(0, y0 - y1 - gap) + '" style="fill:var(--' + s.color + ')"/>'; });
      bars += '<g clip-path="url(#' + this.uid + 'c' + i + ')">' + segs + '</g>';
      if (i % every === 0) xl += '<text x="' + (x + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle" style="fill:var(--muted-foreground);font-size:11px">' + l + '</text>';
      hits += '<rect data-i="' + i + '" x="' + (padL + band * i) + '" y="' + padT + '" width="' + band + '" height="' + ih + '" fill="transparent"/>';
    });
    plot.innerHTML = '<svg width="' + W + '" height="' + H + '" class="block overflow-visible"><defs>' + clips +
      '<clipPath id="' + this.uid + 'area"><rect x="0" y="0" width="' + W + '" height="' + (padT + ih) + '"/></clipPath></defs>' + grid +
      '<g clip-path="url(#' + this.uid + 'area)">' + bars + '</g>' + xl + '<line data-c="cross" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ih) + '" style="stroke:var(--foreground);opacity:0" stroke-width="1"/>' + hits + '</svg>' +
      '<div data-c="tip" class="pointer-events-none absolute z-10 hidden min-w-40 rounded-lg border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg"></div>';
    const tip = plot.querySelector('[data-c="tip"]'); const cross = plot.querySelector('[data-c="cross"]');
    plot.querySelectorAll('rect[data-i]').forEach((r) => {
      r.addEventListener('mouseenter', () => {
        const i = +r.dataset.i; const cx = padL + band * i + band / 2;
        cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '0.15';
        tip.innerHTML = '<div class="mb-1.5 font-medium">' + this.labels[i] + '</div>' + this.series.slice().reverse().map((s) => '<div class="flex items-center gap-2 py-0.5"><span class="size-2 rounded-sm" style="background:var(--' + s.color + ')"></span><span class="text-muted-foreground">' + s.name + '</span><span class="ml-auto pl-4 font-medium tabular-nums">' + tfFmt(s.values[i] || 0, this.unit) + '</span></div>').join('') +
          '<div class="mt-1.5 flex border-t border-border pt-1.5"><span class="text-muted-foreground">Total</span><span class="ml-auto font-semibold tabular-nums">' + tfFmt(totals[i], this.unit) + '</span></div>';
        tip.classList.remove('hidden');
        const left = cx + 12 + 170 > W ? cx - 12 - tip.offsetWidth : cx + 12;
        tip.style.left = left + 'px'; tip.style.top = Math.max(0, y(totals[i]) - 10) + 'px';
      });
      r.addEventListener('mouseleave', () => { tip.classList.add('hidden'); cross.style.opacity = '0'; });
    });
  }
}
customElements.define('tf-bar-chart', TfBarChart);
