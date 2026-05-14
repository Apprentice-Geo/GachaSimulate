# CDF UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the visualize CDF export page into a fixed 1920x1080 dark monitoring dashboard with a dominant 75% CDF chart, grouped statistics, corrected marker labels, and a neutral diagonal PK bar.

**Architecture:** Preserve the existing React data flow, URL/file import behavior, animation state, and export selectors. Rework the visual layer through focused changes to the chart, statistics panel, termination bar, design tokens, and layout CSS. Keep computation helpers in `src/visualize/data/cdf.ts` so rendering components stay display-focused.

**Tech Stack:** React 19, TypeScript, Vite, Recharts, CSS modules-by-convention through global CSS, Playwright e2e tests.

---

## File Map

- Modify `docs/VISUALIZE_DEVELOP.md`: sync approved design changes into project requirements.
- Modify `src/visualize/data/cdf.ts`: update MEAN marker color and add label placement helpers if useful.
- Modify `src/visualize/components/CDFChart.tsx`: add Y-axis label, grid behavior, dashed marker lines, and safer marker label layout.
- Modify `src/visualize/components/StatisticPanel.tsx`: render grouped statistic sections instead of a flat list.
- Modify `src/visualize/components/TerminationBar.tsx`: use neutral PK colors and a left-leaning 45-degree junction for two segments.
- Modify `src/visualize/styles/tokens.css`: update dark dashboard tokens and neutral PK colors.
- Modify `src/visualize/styles/layout.css`: implement 75/25 layout, dark visual direction, grouped statistics, chart label styles, and PK bar seam.
- Modify `e2e/visualize.spec.ts`: add assertions for 75/25 layout, grouped statistics, Y-axis label, dashed markers, MEAN color, and PK seam.
- Optionally modify `src/visualize/test/cdf.test.ts`: add a direct assertion for MEAN marker color if helper-level coverage is useful.

## Task 1: Sync Requirements Document

**Files:**
- Modify: `docs/VISUALIZE_DEVELOP.md`

- [ ] **Step 1: Update main layout ratio text**

Replace both 62% / 38% references with 75% / 25%. The text should say the left CDF chart occupies about 75% of the main content width and the right statistic panel occupies about 25%.

- [ ] **Step 2: Update statistic panel requirement**

Replace the flat nine-row requirement with:

```markdown
右侧统计面板将八个分布统计量按语义分为三组展示，并在面板底部显示第九个核心统计量“单抽成本”：

- 较优结果：MIN / P5 / P25
- 中心位置：P50 / MEAN
- 尾部风险：P75 / P95 / MAX

单抽成本作为紧凑的成本参考行展示，不参与分布风险分组。每个统计量仍应包含统计量名称、简短说明、统计量数值和单位。右侧面板宽度约为主内容区 25%，因此分组应紧凑，不应抢占 CDF 曲线注意力。
```

- [ ] **Step 3: Update PK bar requirement**

Add this to the bottom termination section:

```markdown
终止原因 PK 条颜色不表达好坏语义。必须固定使用语义中性但对比明确的两种颜色：Sentry Violet Link `#6a5fc1` 与 Sentry Hot Pink `#fa7faa`。如果只有一种终止原因，使用 `#6a5fc1` 填满单条；如果有两种终止原因，两段交界使用左斜 45° 斜线，不使用竖直分割线。
```

- [ ] **Step 4: Verify the requirement text**

Run:

```powershell
Select-String -Path docs/VISUALIZE_DEVELOP.md -Pattern '75|25|较优结果|中心位置|尾部风险|45|#6a5fc1|#fa7faa|#952fc6'
```

Expected: matches for all approved requirements.

- [ ] **Step 5: Commit**

```powershell
git add docs/VISUALIZE_DEVELOP.md
git commit -m "docs: sync cdf redesign requirements"
```

## Task 2: Add Failing Coverage For Visual Contracts

**Files:**
- Modify: `e2e/visualize.spec.ts`
- Modify: `src/visualize/test/cdf.test.ts`

- [ ] **Step 1: Add helper-level MEAN color assertion**

Append this to `src/visualize/test/cdf.test.ts`:

```ts
import { MARKER_COLORS } from '../data/cdf';

assert.equal(MARKER_COLORS.MEAN, '#952fc6');
```

If the file already imports from `../data/cdf`, merge the import into a single import statement.

- [ ] **Step 2: Add e2e visual contract assertions**

In `e2e/visualize.spec.ts`, inside `loads fixture from url input and exposes export selectors`, add these checks after the chart is visible:

```ts
await expect(page.getByText('累计概率 CDF')).toBeVisible();
await expect(page.getByText('较优结果')).toBeVisible();
await expect(page.getByText('中心位置')).toBeVisible();
await expect(page.getByText('尾部风险')).toBeVisible();
await expect(page.getByTestId('stat-COST')).toBeVisible();

const layout_ratio = await page.evaluate(() => {
  const main = document.querySelector('.main-region') as HTMLElement | null;
  const chart = document.querySelector('.chart-region') as HTMLElement | null;
  const stats = document.querySelector('.statistic-panel') as HTMLElement | null;
  if (!main || !chart || !stats) {
    return null;
  }
  return {
    chart_width: chart.getBoundingClientRect().width,
    stats_width: stats.getBoundingClientRect().width,
  };
});
expect(layout_ratio).not.toBeNull();
expect(layout_ratio!.chart_width).toBeGreaterThan(layout_ratio!.stats_width * 2.6);

const marker_contract = await page.evaluate(() => {
  const mean = document.querySelector('[data-marker-key="MEAN"] .marker-line');
  const first_marker = document.querySelector('.marker-line');
  const pk = document.querySelector('.pk-bar[data-segment-count="2"]');
  if (!mean || !first_marker) {
    return null;
  }
  const mean_style = window.getComputedStyle(mean);
  const marker_style = window.getComputedStyle(first_marker);
  const pk_style = pk ? window.getComputedStyle(pk) : null;
  return {
    mean_stroke: mean.getAttribute('stroke'),
    marker_dash: marker_style.strokeDasharray,
    pk_has_diagonal: pk_style?.getPropertyValue('--pk-seam-angle') ?? '',
  };
});
expect(marker_contract).not.toBeNull();
expect(marker_contract!.mean_stroke).toBe('#952fc6');
expect(marker_contract!.marker_dash).not.toBe('none');
expect(marker_contract!.marker_dash).not.toBe('1px');
```

- [ ] **Step 3: Run helper test to confirm it fails before implementation**

Run:

```powershell
npm run test:visualize:cdf
```

Expected before implementation: FAIL because `MARKER_COLORS.MEAN` is still `#fa7faa`.

- [ ] **Step 4: Run e2e test to confirm visual contract fails before implementation**

Run:

```powershell
npm run test:e2e
```

Expected before implementation: FAIL because grouped headings, Y-axis label, and layout ratio are not implemented.

## Task 3: Update CDF Data Constants

**Files:**
- Modify: `src/visualize/data/cdf.ts`

- [ ] **Step 1: Change MEAN marker color**

Update:

```ts
MEAN: '#fa7faa',
```

to:

```ts
MEAN: '#952fc6',
```

- [ ] **Step 2: Run helper test**

Run:

```powershell
npm run test:visualize:cdf
```

Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add src/visualize/data/cdf.ts src/visualize/test/cdf.test.ts
git commit -m "feat: update mean marker color"
```

## Task 4: Rework Fixed Layout And Dark Tokens

**Files:**
- Modify: `src/visualize/styles/tokens.css`
- Modify: `src/visualize/styles/layout.css`

- [ ] **Step 1: Update tokens**

Set the core visual tokens to dark dashboard values:

```css
:root {
  --color-canvas: #120d1f;
  --color-panel: #1b142b;
  --color-panel-soft: #211936;
  --color-hairline: #362d59;
  --color-hairline-strong: #51436f;
  --color-text-primary: #f7f3ff;
  --color-text-muted: rgba(247, 243, 255, 0.68);
  --color-text-faint: rgba(247, 243, 255, 0.42);
  --color-pk-a: #6a5fc1;
  --color-pk-b: #fa7faa;
}
```

Keep existing semantic marker color tokens that are still used.

- [ ] **Step 2: Change main grid ratio**

In `.main-region`, change:

```css
grid-template-columns: minmax(0, 62fr) minmax(0, 38fr);
```

to:

```css
grid-template-columns: minmax(0, 75fr) minmax(0, 25fr);
```

- [ ] **Step 3: Convert page and surfaces to dark dashboard styling**

Update `.visualize-page`, `.cdf-chart-shell`, `.statistic-panel`, `.state-panel`, and `.termination-region` to use the dark tokens. Use hairline borders and subtle inset/outer shadows only; do not add decorative blobs or large gradients.

- [ ] **Step 4: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/visualize/styles/tokens.css src/visualize/styles/layout.css
git commit -m "feat: apply dark cdf dashboard layout"
```

## Task 5: Rework CDF Chart Details

**Files:**
- Modify: `src/visualize/components/CDFChart.tsx`
- Modify: `src/visualize/styles/layout.css`

- [ ] **Step 1: Add marker key attributes**

On each marker group, add:

```tsx
data-marker-key={view.marker.key}
```

- [ ] **Step 2: Add visible Y-axis label**

Add a chart label element inside `.cdf-chart-shell`:

```tsx
<div className="y-axis-title">累计概率 CDF</div>
```

Style it in CSS as a rotated label inside the chart frame, readable but secondary.

- [ ] **Step 3: Make grid visible and low contrast**

Update `CartesianGrid` to:

```tsx
<CartesianGrid
  stroke="rgba(247, 243, 255, 0.12)"
  strokeDasharray="4 10"
  vertical
/>
```

- [ ] **Step 4: Use real dashed marker lines**

Change marker and MEAN line dash attributes from:

```tsx
strokeDasharray="1"
```

to:

```tsx
strokeDasharray="7 9"
```

Keep `pathLength={1}` only if animation still behaves correctly. If CSS animation conflicts with real dash rendering, remove `pathLength` from marker lines and animate opacity/scale instead.

- [ ] **Step 5: Improve label placement**

Update `build_marker_views` so default percentile labels use left/above placement, MEAN uses right/below placement, MAX stays inside right edge, and close labels stagger vertically. Keep the current P50/MEAN special case, but make it consistent with the reference behavior from `src/simulate/visualize.py:593`.

Use this placement logic:

```ts
let label_x = x - 8;
let label_y = y - 8;
let text_anchor: MarkerView['text_anchor'] = 'end';

if (marker.key === 'MEAN') {
  label_x = x + 10;
  label_y = y + 18;
  text_anchor = 'start';
}

if (marker.key === 'MAX') {
  label_x = x - 10;
  label_y = y - 10;
  text_anchor = 'end';
}

label_x = clamp(label_x, plot_box.left + 10, plot_box.left + plot_box.width - 10);
label_y = clamp(label_y, plot_box.top + 18, plot_box.bottom - 10);
```

Then apply vertical staggering for labels whose `label_x` positions are within 42px of a previous label.

- [ ] **Step 6: Run e2e**

Run:

```powershell
npm run test:e2e
```

Expected: may still fail on statistics and PK bar until later tasks, but chart-specific assertions should pass.

- [ ] **Step 7: Commit**

```powershell
git add src/visualize/components/CDFChart.tsx src/visualize/styles/layout.css e2e/visualize.spec.ts
git commit -m "feat: refine cdf chart markers"
```

## Task 6: Group Statistic Panel

**Files:**
- Modify: `src/visualize/components/StatisticPanel.tsx`
- Modify: `src/visualize/styles/layout.css`

- [ ] **Step 1: Define groups in the component**

Add:

```ts
const METRIC_GROUPS = [
  {
    title: '较优结果',
    description: '低抽数区间',
    keys: ['MIN', 'P5', 'P25'],
  },
  {
    title: '中心位置',
    description: '典型结果',
    keys: ['P50', 'MEAN'],
  },
  {
    title: '尾部风险',
    description: '高抽数区间',
    keys: ['P75', 'P95', 'MAX'],
  },
] as const;
```

- [ ] **Step 2: Render grouped sections**

Replace the flat `.metric-list` mapping with grouped sections for MIN through MAX. Render `COST` as a compact `.metric-cost-row` below the three groups. Keep `data-testid={`stat-${metric.key}`}` on each metric row, including `data-testid="stat-COST"`, so existing and new tests can address every metric.

- [ ] **Step 3: Add short metric explanations**

Add a local label map:

```ts
const METRIC_DESCRIPTIONS: Record<string, string> = {
  MIN: '最优样本',
  P5: '5% 分位',
  P25: '25% 分位',
  P50: '中位抽数',
  MEAN: '平均抽数',
  P75: '75% 分位',
  P95: '95% 分位',
  MAX: '最差尾部',
  COST: '单抽成本',
};
```

The normalized data model already uses `COST`; do not invent another key.

- [ ] **Step 4: Style grouped panel**

Add `.metric-group`, `.metric-group-heading`, `.metric-description`, compact `.metric-row`, and `.metric-cost-row` styles. Keep row heights stable so all three groups plus the cost row fit within 760px.

- [ ] **Step 5: Run e2e**

Run:

```powershell
npm run test:e2e
```

Expected: grouped heading assertions pass.

- [ ] **Step 6: Commit**

```powershell
git add src/visualize/components/StatisticPanel.tsx src/visualize/styles/layout.css
git commit -m "feat: group cdf statistic panel"
```

## Task 7: Rework Termination PK Bar

**Files:**
- Modify: `src/visualize/components/TerminationBar.tsx`
- Modify: `src/visualize/styles/layout.css`

- [ ] **Step 1: Replace segment colors**

Change `get_segment_color` to:

```ts
function get_segment_color(index: number): string {
  return index === 0 ? '#6a5fc1' : '#fa7faa';
}
```

- [ ] **Step 2: Add segment count attribute**

On `.pk-bar`, add:

```tsx
data-segment-count={data.termination_reason.length}
```

- [ ] **Step 3: Add diagonal junction class**

For the second segment, add a class such as `pk-segment-diagonal` only when there are exactly two segments.

- [ ] **Step 4: Implement left-leaning 45-degree junction**

Use CSS that keeps proportions accurate enough for visual export:

```css
.pk-bar {
  --pk-seam-angle: -45deg;
}

.pk-segment-diagonal {
  clip-path: polygon(18px 0, 100% 0, 100% 100%, 0 100%);
  margin-left: -18px;
  padding-left: 18px;
}
```

If the 18px overlap causes visible percentage distortion for narrow second segments, reduce the seam width to 12px.

- [ ] **Step 5: Run e2e**

Run:

```powershell
npm run test:e2e
```

Expected: PK seam and visual contract assertions pass.

- [ ] **Step 6: Commit**

```powershell
git add src/visualize/components/TerminationBar.tsx src/visualize/styles/layout.css
git commit -m "feat: add neutral diagonal termination bar"
```

## Task 8: Full Verification And Export Smoke Test

**Files:**
- No source changes expected unless verification finds a bug.

- [ ] **Step 1: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: PASS and `dist/` is generated.

- [ ] **Step 3: Run e2e**

Run:

```powershell
npm run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Run export smoke test**

Run:

```powershell
npm run export:cdf -- --input src/visualize/fixtures/example_input.json
```

Expected: `outputs/cdf-result.png`, `outputs/cdf-animation.webm`, and `outputs/cdf-animation.mp4` are generated. If FFmpeg is unavailable, document the exact failure and confirm PNG/WebM behavior.

- [ ] **Step 5: Inspect final git status**

Run:

```powershell
git status --short
```

Expected: only intentional source/doc changes are present. Do not add `.superpowers/` companion files.

- [ ] **Step 6: Commit verification fixes if needed**

If verification required fixes:

```powershell
git add <changed-files>
git commit -m "fix: polish cdf redesign verification"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

Spec coverage:
- Fixed 1920x1080 target: Task 4 and Task 8.
- 75% / 25% main layout: Task 1 and Task 4.
- Dark Sentry dashboard with NVIDIA technical accents: Task 4.
- CDF grid, Y-axis label, dashed marker lines, label collision handling: Task 5.
- MEAN color `#952fc6`: Task 1, Task 2, Task 3, Task 5.
- Grouped statistic panel: Task 1, Task 2, Task 6.
- Neutral diagonal PK bar: Task 1, Task 2, Task 7.
- Existing export selectors and animation contract: Task 2 and Task 8.

Placeholder scan:
- No placeholder markers or deferred implementation notes are intentionally left in the task steps.
- The only conditional instruction is the explicit FFmpeg unavailable case in Task 8, because the local machine may not have FFmpeg available.

Type consistency:
- Existing selectors `data-testid="cdf-chart"`, `data-testid="cdf-curve-path"`, `data-testid="replay-animation"`, and `data-testid="stat-P50"` are preserved.
- New marker selector uses `data-marker-key="MEAN"` consistently in the plan and tests.
