import { useState } from "react";
import type { SetupSummary } from "../../../src/eval/types";
import { formatPercent, formatUsd, setupLabel } from "../format";

// The drawing is laid out in these units. The SVG then scales to the width of its box.
const WIDTH = 640;
const HEIGHT = 380;
// Room around the plot for the tick values and the axis titles.
const MARGIN = { top: 16, right: 24, bottom: 54, left: 64 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const PLOT_RIGHT = WIDTH - MARGIN.right;
const PLOT_BOTTOM = HEIGHT - MARGIN.bottom;
// Rough size of a setup ID written at 13 units, used to keep labels apart.
const LABEL_CHAR_WIDTH = 9;
const LABEL_HEIGHT = 15;
// A log scale has no place for zero, so a cost below a tenth of a cent is drawn at a tenth of a cent.
const LOWEST_COST = 0.001;

type Props = {
  setups: SetupSummary[];
  /** IDs of the setups where no other setup is both cheaper and more accurate. */
  frontier: string[];
};

type Point = {
  summary: SetupSummary;
  x: number;
  y: number;
  /** Top and bottom of the line from the lowest repeat to the highest. */
  yHigh: number;
  yLow: number;
  onFrontier: boolean;
};
type Box = { left: number; top: number; right: number; bottom: number };

/**
 * A scatter plot with one point for each setup. Cost per answer runs left to right and
 * correctness runs bottom to top, so the best place to be is the top left.
 * Frontier setups are filled dots joined by a line. The others are hollow rings,
 * so the two kinds can be told apart without colour.
 *
 * The cost axis is a log scale. The cheapest setup costs under one cent an answer and the most
 * expensive costs tens of cents. On a straight scale the cheap setups would crowd into the left
 * third of the chart.
 */
export function CostChart({ setups, frontier }: Props) {
  // The setup under the pointer or with keyboard focus. Its numbers show in a small box.
  const [activeId, setActiveId] = useState<string | null>(null);

  if (setups.length === 0) {
    return null;
  }

  // Cost axis. It runs from the round value below the cheapest setup to the one above the most expensive.
  const costs = setups.map((s) => Math.max(s.cost_per_answer_usd, LOWEST_COST));
  const costTicks = logTicks(Math.min(...costs), Math.max(...costs));
  const costMin = costTicks[0] ?? LOWEST_COST;
  const costMax = costTicks.at(-1) ?? 1;

  // Correctness axis, in whole percent. It starts at the ten below the lowest value, not at zero.
  // From zero, every setup would sit in a thin band at the top and the gaps would be unreadable.
  const lowest = Math.min(...setups.map((s) => s.correctness_min)) * 100;
  const percentMin = Math.min(90, Math.floor(lowest / 10) * 10);
  const percentTicks: number[] = [];
  for (let percent = percentMin; percent <= 100; percent += 10) {
    percentTicks.push(percent);
  }

  // These two functions turn a value into a position in the drawing.
  // On the log scale a cost that is twice as high sits the same distance to the right, at any cost.
  const xOf = (cost: number) =>
    MARGIN.left +
    (Math.log(Math.max(cost, LOWEST_COST) / costMin) / Math.log(costMax / costMin)) * PLOT_WIDTH;
  const yOf = (correctness: number) =>
    PLOT_BOTTOM - ((correctness * 100 - percentMin) / (100 - percentMin)) * PLOT_HEIGHT;

  const points: Point[] = setups.map((summary) => ({
    summary,
    x: xOf(summary.cost_per_answer_usd),
    y: yOf(summary.correctness),
    yHigh: yOf(summary.correctness_max),
    yLow: yOf(summary.correctness_min),
    onFrontier: frontier.includes(summary.setup.id),
  }));
  // The frontier line goes from the cheapest frontier setup to the most expensive one.
  const frontierLine = points
    .filter((p) => p.onFrontier)
    .sort((a, b) => a.x - b.x)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
  const labels = placeLabels(points);
  // Frontier dots are drawn last. A ring that lands on the same spot then cannot hide one.
  const drawOrder = [...points].sort((a, b) => Number(a.onFrontier) - Number(b.onFrontier));
  const active = points.find((p) => p.summary.setup.id === activeId);
  // With one repeat the lowest and highest are equal, so there are no range lines to explain.
  const hasRanges = setups.some((s) => s.correctness_min !== s.correctness_max);

  return (
    <figure className="chart">
      <ul className="chart-legend">
        <li>
          <svg width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="8" r="5" className="chart-dot-frontier" />
          </svg>
          On the frontier. No other setup is both cheaper and more accurate.
        </li>
        <li>
          <svg width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="8" r="4" className="chart-dot-other" />
          </svg>
          Other setups
        </li>
        {hasRanges && (
          <li>
            <svg width="16" height="16" aria-hidden="true">
              <line x1="8" y1="1" x2="8" y2="15" className="chart-range" />
            </svg>
            Lowest and highest repeat
          </li>
        )}
      </ul>

      <div className="chart-scroll">
        <div className="chart-box">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="group"
            aria-label="Scatter plot of correctness against cost per answer, one point for each setup. The table above has the same numbers."
          >
            {/* Grid lines and tick values. */}
            {percentTicks.map((percent) => (
              <g key={percent}>
                <line
                  className="chart-grid"
                  x1={MARGIN.left}
                  x2={PLOT_RIGHT}
                  y1={yOf(percent / 100)}
                  y2={yOf(percent / 100)}
                />
                <text
                  className="chart-tick"
                  x={MARGIN.left - 8}
                  y={yOf(percent / 100) + 4}
                  textAnchor="end"
                >
                  {percent}%
                </text>
              </g>
            ))}
            {costTicks.map((cost) => (
              <g key={cost}>
                <line
                  className="chart-grid"
                  x1={xOf(cost)}
                  x2={xOf(cost)}
                  y1={MARGIN.top}
                  y2={PLOT_BOTTOM}
                />
                <text className="chart-tick" x={xOf(cost)} y={PLOT_BOTTOM + 18} textAnchor="middle">
                  ${cost.toFixed(cost < 0.01 ? 3 : 2)}
                </text>
              </g>
            ))}

            {/* The two axis lines, then their titles. */}
            <line
              className="chart-axis"
              x1={MARGIN.left}
              x2={PLOT_RIGHT}
              y1={PLOT_BOTTOM}
              y2={PLOT_BOTTOM}
            />
            <line
              className="chart-axis"
              x1={MARGIN.left}
              x2={MARGIN.left}
              y1={MARGIN.top}
              y2={PLOT_BOTTOM}
            />
            <text
              className="chart-title"
              x={MARGIN.left + PLOT_WIDTH / 2}
              y={HEIGHT - 10}
              textAnchor="middle"
            >
              Cost per answer (US dollars, estimate at list prices, log scale)
            </text>
            {/* Turned a quarter, so x and y swap. This sits to the left of the plot, reading upwards. */}
            <text
              className="chart-title"
              transform="rotate(-90)"
              x={-(MARGIN.top + PLOT_HEIGHT / 2)}
              y={16}
              textAnchor="middle"
            >
              Correctness (%)
            </text>

            <polyline className="chart-frontier-line" points={frontierLine} />

            {drawOrder.map((p) => {
              const id = p.summary.setup.id;
              const label = labels.get(id);
              return (
                <g
                  key={id}
                  className="chart-point"
                  tabIndex={0}
                  role="img"
                  aria-label={describe(p.summary, p.onFrontier)}
                  onMouseEnter={() => setActiveId(id)}
                  onMouseLeave={() => setActiveId(null)}
                  onFocus={() => setActiveId(id)}
                  onBlur={() => setActiveId(null)}
                >
                  {/* Has no length when every repeat scored the same, so nothing shows. */}
                  <line className="chart-range" x1={p.x} x2={p.x} y1={p.yLow} y2={p.yHigh} />
                  {/* An invisible circle, bigger than the dot, so the point is easy to hit. */}
                  <circle className="chart-hit" cx={p.x} cy={p.y} r={14} />
                  <circle
                    className={p.onFrontier ? "chart-dot-frontier" : "chart-dot-other"}
                    cx={p.x}
                    cy={p.y}
                    r={id === activeId ? 7 : 5}
                  />
                  {label && (
                    <text className="chart-label" x={label.x} y={label.y}>
                      {id}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* The readout is plain HTML laid over the SVG. Percentages keep it on the point at any width. */}
          {active && (
            <div
              className={
                active.x > WIDTH / 2 ? "chart-tooltip chart-tooltip-left" : "chart-tooltip"
              }
              style={{ left: `${(active.x / WIDTH) * 100}%`, top: `${(active.y / HEIGHT) * 100}%` }}
            >
              <strong>{formatPercent(active.summary.correctness)}</strong> correct
              <br />
              <strong>{formatUsd(active.summary.cost_per_answer_usd)}</strong> per answer
              <br />
              {setupLabel(active.summary.setup)}
            </div>
          )}
        </div>
      </div>

      <figcaption className="hint">
        Higher is more accurate and further left is cheaper. The correctness axis starts at{" "}
        {percentMin}%, not at zero. The cost axis is a log scale, so each marked value is about
        double the one before it. The table above has the exact numbers.
      </figcaption>
    </figure>
  );
}

/**
 * The tick values of the log axis. They are 1, 2 and 5 times a power of ten, such as $0.005, $0.01,
 * $0.02 and $0.05. The list starts at the last round value that is not above `lowest` and ends
 * at the first one above `highest`, so every point lies between the first tick and the last.
 */
function logTicks(lowest: number, highest: number): number[] {
  // One power of ten past both ends, so there is always a round value on each side.
  const firstPower = Math.floor(Math.log10(lowest)) - 1;
  const lastPower = Math.ceil(Math.log10(highest)) + 1;
  const round: number[] = [];
  for (let power = firstPower; power <= lastPower; power++) {
    round.push(1 * 10 ** power, 2 * 10 ** power, 5 * 10 ** power);
  }
  const start = round.findLastIndex((tick) => tick <= lowest);
  const end = round.findIndex((tick) => tick > highest);
  return round.slice(start, end + 1);
}

/** The area two boxes share. Zero when they do not touch. */
function sharedArea(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Picks where each setup ID is written. For each point it looks at four spots and takes the one
 * that covers the least of the dots, the range lines and the labels placed before it.
 * Two setups often land close together, and one fixed spot would print one label over the other.
 */
function placeLabels(points: Point[]): Map<string, { x: number; y: number }> {
  // Every dot blocks a box around itself, tall enough to cover its range line.
  const taken: Box[] = points.map((p) => ({
    left: p.x - 8,
    right: p.x + 8,
    top: Math.min(p.y - 8, p.yHigh),
    bottom: Math.max(p.y + 8, p.yLow),
  }));
  const places = new Map<string, { x: number; y: number }>();

  for (const p of points) {
    const id = p.summary.setup.id;
    const width = id.length * LABEL_CHAR_WIDTH;
    const right = p.x + 9;
    const left = p.x - 9 - width;
    const above = p.y - 6 - LABEL_HEIGHT;
    const below = p.y + 6;
    // A tie goes to the spot listed first. The frontier line climbs to the right, so above left
    // and below right of a frontier point are clear of it and come first for those points.
    // Every other point lies under the line, so its label goes below the dot first.
    const corners = p.onFrontier
      ? [
          { left, top: above },
          { left: right, top: below },
          { left: right, top: above },
          { left, top: below },
        ]
      : [
          { left: right, top: below },
          { left, top: below },
          { left: right, top: above },
          { left, top: above },
        ];

    let best: Box | null = null;
    let bestCovered = Infinity;
    for (const corner of corners) {
      const spot: Box = {
        ...corner,
        right: corner.left + width,
        bottom: corner.top + LABEL_HEIGHT,
      };
      // A label never crosses the axis lines or leaves the drawing.
      const inside =
        spot.left >= MARGIN.left &&
        spot.right <= WIDTH &&
        spot.top >= 0 &&
        spot.bottom <= PLOT_BOTTOM;
      if (!inside) continue;
      const covered = taken.reduce((sum, other) => sum + sharedArea(spot, other), 0);
      if (covered < bestCovered) {
        best = spot;
        bestCovered = covered;
      }
    }
    // No spot fits only when the plot is too small for any label. Then the ID is left off.
    if (!best) continue;
    taken.push(best);
    // SVG places text by its baseline, which is near the bottom of the box.
    places.set(id, { x: best.left, y: best.bottom - 3 });
  }
  return places;
}

/** The sentence a screen reader says for one point. */
function describe(summary: SetupSummary, onFrontier: boolean): string {
  return (
    `${setupLabel(summary.setup)}. Correctness ${formatPercent(summary.correctness)}. ` +
    `Cost per answer ${formatUsd(summary.cost_per_answer_usd)}. ` +
    (onFrontier ? "On the frontier." : "Not on the frontier.")
  );
}
