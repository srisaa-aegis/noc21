import { Component, computed, input } from '@angular/core';

export interface ChartSeries {
  label: string;
  color: string;
  values: number[];
}

interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  value: number;
  label: string;
}

/**
 * Dependency-free grouped bar chart (SVG) for the report dashboards. One group per category, one
 * bar per series; value labels on the bars; legend below. Accessible through aria-label and a
 * visually hidden data table.
 */
@Component({
  selector: 'app-bar-chart',
  template: `
    <figure class="chart">
      <svg [attr.viewBox]="'0 0 ' + width + ' ' + height()" role="img" [attr.aria-label]="title()" preserveAspectRatio="xMidYMid meet">
        <title>{{ title() }}</title>
        @for (t of ticks(); track t.value) {
          <line class="grid" [attr.x1]="padL" [attr.x2]="width - padR" [attr.y1]="t.y" [attr.y2]="t.y"></line>
          <text class="tick" [attr.x]="padL - 6" [attr.y]="t.y + 4" text-anchor="end">{{ t.value }}</text>
        }
        @for (b of bars(); track $index) {
          <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" [attr.fill]="b.color" rx="3">
            <title>{{ b.label }}: {{ b.value }}</title>
          </rect>
          @if (b.value > 0) {
            <text class="val" [attr.x]="b.x + b.w / 2" [attr.y]="b.y - 4" text-anchor="middle">{{ b.value }}</text>
          }
        }
        @for (c of categoryLabels(); track $index) {
          <text class="cat" [attr.x]="c.x" [attr.y]="height() - 8" text-anchor="middle">{{ c.label }}</text>
        }
        <line class="axis" [attr.x1]="padL" [attr.x2]="width - padR" [attr.y1]="baseY()" [attr.y2]="baseY()"></line>
      </svg>
      @if (series().length > 1) {
        <figcaption class="legend">
          @for (s of series(); track s.label) {
            <span><i [style.background]="s.color"></i>{{ s.label }}</span>
          }
        </figcaption>
      }
      <table class="visually-hidden">
        <caption>{{ title() }}</caption>
        <tr><th></th>@for (s of series(); track s.label) { <th>{{ s.label }}</th> }</tr>
        @for (c of categories(); track $index; let ci = $index) {
          <tr><th>{{ c }}</th>@for (s of series(); track s.label) { <td>{{ s.values[ci] }}</td> }</tr>
        }
      </table>
    </figure>
  `,
  styles: `
    :host { display: block; }
    .chart { margin: 0; }
    svg { width: 100%; height: auto; display: block; }
    .grid { stroke: var(--gray-100); }
    .axis { stroke: var(--gray-300); }
    .tick { font-size: 11px; fill: var(--gray-500); }
    .val { font-size: 11px; font-weight: 700; fill: var(--gray-700); }
    .cat { font-size: 12px; fill: var(--gray-700); font-weight: 600; }
    .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; justify-content: center; font-size: var(--font-size-xs); color: var(--gray-600); margin-top: 4px; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  `,
})
export class BarChart {
  readonly title = input('Chart');
  readonly categories = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();
  readonly height = input(240);

  protected readonly width = 560;
  protected readonly padL = 36;
  protected readonly padR = 12;
  private readonly padT = 18;
  private readonly padB = 28;

  protected readonly baseY = computed(() => this.height() - this.padB);

  private readonly max = computed(() => {
    const m = Math.max(0, ...this.series().flatMap((s) => s.values));
    if (m <= 4) return Math.max(m, 1) <= 2 ? 2 : 4;
    const step = Math.pow(10, Math.floor(Math.log10(m)));
    return Math.ceil(m / step) * step;
  });

  protected readonly ticks = computed(() => {
    const max = this.max();
    const plot = this.baseY() - this.padT;
    return [0, max / 2, max].map((v) => ({ value: Math.round(v * 100) / 100, y: this.baseY() - (v / max) * plot }));
  });

  private readonly groupWidth = computed(() => (this.width - this.padL - this.padR) / Math.max(1, this.categories().length));

  protected readonly bars = computed<Bar[]>(() => {
    const series = this.series();
    const gw = this.groupWidth();
    const inner = gw * 0.72;
    const bw = inner / Math.max(1, series.length);
    const plot = this.baseY() - this.padT;
    const max = this.max();
    const out: Bar[] = [];
    this.categories().forEach((c, ci) => {
      const x0 = this.padL + ci * gw + (gw - inner) / 2;
      series.forEach((s, si) => {
        const v = s.values[ci] ?? 0;
        const h = (v / max) * plot;
        out.push({ x: x0 + si * bw + 1, y: this.baseY() - h, w: Math.max(2, bw - 2), h, color: s.color, value: v, label: `${c} · ${s.label}` });
      });
    });
    return out;
  });

  protected readonly categoryLabels = computed(() =>
    this.categories().map((label, ci) => ({ label, x: this.padL + ci * this.groupWidth() + this.groupWidth() / 2 })),
  );
}
