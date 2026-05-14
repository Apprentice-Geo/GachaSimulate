# CDF UI Redesign Design

Date: 2026-05-14

## Goal

Redesign the visualize UI for exported 1920x1080 CDF analysis material. The output should read as a high-end dark monitoring dashboard: data-first, dense, precise, and suitable for PNG/WebM/MP4 export.

The browser development view may require scrolling. The fixed 1920x1080 export canvas is the primary target.

## Scope

In scope:
- Redesign the fixed canvas layout and visual language.
- Rework the CDF chart presentation, marker lines, marker labels, grid, and axis labels.
- Rework the statistic panel into grouped risk sections.
- Rework the termination PK bar colors and segment junction.
- Update `docs/VISUALIZE_DEVELOP.md` to match the approved design changes.

Out of scope:
- Changing simulation logic.
- Changing input data semantics.
- Adding general BI interactions.
- Changing the export contract except where visual readiness depends on existing selectors and animation timing.

## Visual Direction

Use Sentry as the main UI language and NVIDIA as a restrained technical accent.

The design direction is "dark monitoring console with a small amount of technical terminal detail":
- Deep violet / graphite canvas.
- Dense dashboard information hierarchy.
- Cyan CDF curve as the primary visual signal.
- NVIDIA green only for small technical accents, lines, corner details, and existing percentile semantics.
- No mascot, marketing hero, or game-style HUD treatment.
- No decoration that competes with data readability.

## Layout

Canvas remains fixed at 1920x1080.

Primary layout:
- Page margin: 64px.
- Top title area: 96px.
- Main content area: 760px.
- Footer / termination area: 140px.

Main content ratio changes to:
- Left CDF chart: 75%.
- Right statistic panel: 25%.

This supersedes the earlier 62% / 38% ratio. The chart is the dominant element, and the statistic panel becomes a compact supporting readout.

## CDF Chart

The chart is the visual anchor of the page.

Required behavior:
- Draw the CDF exactly from input `draws` and `cumulative`.
- X axis represents draw count and uses integer labels.
- Y axis represents cumulative probability and uses percentage labels.
- Add an explicit Y-axis label: `累计概率 CDF`.
- Enable low-contrast horizontal and vertical grid lines.
- Keep grid lines visible enough for reading values but subordinate to the curve.

Marker lines:
- MIN, P5, P25, P50, P75, P95, MAX use vertical dashed marker lines.
- MEAN uses both a vertical dashed line and a horizontal dashed line.
- Marker lines stop at the corresponding curve intersection rather than extending through the whole plot.
- Lines must be visibly dashed, not effectively solid.

Marker visual weight:
- P50 has the highest marker weight.
- MEAN, P95, and MAX are secondary.
- P25 and P75 are medium.
- MIN and P5 are faint.

Marker labels:
- Label placement should follow the intent of `src/simulate/visualize.py:593`: percentile labels sit near the point, to the left and above where possible.
- MEAN follows the opposite placement: right and below where possible.
- MAX stays inside the upper-right chart boundary.
- Add collision handling so labels do not overlap the curve, each other, or chart edges in obvious cases.
- P50 and MEAN must be offset when close.
- Dense neighboring labels should use vertical staggering.

## Statistic Panel

The statistic panel changes from nine equal rows to three grouped sections.

Groups:
- `较优结果`: MIN, P5, P25.
- `中心位置`: P50, MEAN.
- `尾部风险`: P75, P95, MAX.

Each metric still shows:
- Name.
- Short explanation.
- Value.
- Unit.

The panel should stay compact because it now occupies 25% of the main content width. P50 and MEAN may receive slightly stronger emphasis within the center group, but all nine metrics remain visible and comparable.

## Termination PK Bar

The termination bar should not encode success/failure semantics through green/red because termination reasons are not guaranteed to have stable good/bad meaning.

Use two neutral but distinct Sentry-compatible accent colors:
- Segment A: Violet Link `#6a5fc1`.
- Segment B: Hot Pink `#fa7faa`.

If only one termination reason exists, it fills the full bar.

If two reasons exist:
- Render both proportions directly from input.
- Use a left-leaning 45-degree diagonal junction between the segments instead of a vertical split.
- The legend maps colors to reason labels and percentages without implying semantic value.

## Animation

Keep the existing approximately 3 second animation timeline:
- Background, main surfaces, and title fade in first.
- CDF curve draws left to right.
- Marker lines and labels appear after the curve begins drawing.
- Statistic groups appear in sequence.
- Termination bar and note appear last.

The animation must remain calm and export-friendly. No bounce or exaggerated motion.

## Implementation Boundaries

Preserve:
- Existing input loading paths.
- Existing normalized data model unless a small display-only field is useful.
- Existing export script contract.
- Existing Playwright selectors, especially `data-testid="replay-animation"`.
- Existing animation readiness signals.

Allowed changes:
- Component DOM structure for `CDFChart`, `StatisticPanel`, and `TerminationBar`.
- CSS tokens and layout styles.
- CDF label placement helpers.
- Documentation updates to reflect the approved design.

## Verification

Success criteria:
- `npm run typecheck` passes.
- `npm run build` passes.
- `npm run test:e2e` passes, or any failure is explained with a concrete cause.
- A fixture render shows a fixed 1920x1080 canvas with a dominant 75% CDF chart.
- CDF marker lines are visibly dashed.
- Y axis has a readable label.
- CDF grid lines are visible and low-contrast.
- Statistic panel is grouped into three sections.
- PK bar uses neutral violet/pink colors and a left-leaning 45-degree segment junction when two reasons exist.
- Export output remains compatible with the existing screenshot/video workflow.
