import { useEffect, useId, useState } from "react";
import type {
  SimulationStage,
  SimulationStatus,
} from "../../shared/simulation";
import "./SimulationOrbit.css";

const labels: Record<SimulationStatus, string> = {
  idle: "待运行",
  starting: "编译配置",
  running: "运行模拟",
  saving: "正在保存 GSR",
  completed: "已完成",
  failed: "运行失败",
  cancelling: "正在取消",
  cancelled: "已取消",
};

const cards = [
  { color: "blue", angle: -24 },
  { color: "purple", angle: 0 },
  { color: "gold", angle: 24 },
] as const;

export function SimulationOrbit({
  status,
  stage,
  progress,
  active,
}: {
  status: SimulationStatus;
  stage: SimulationStage | null;
  progress: { completed: number; total: number } | null;
  active: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const percent = progress
    ? Math.min(100, Math.max(0, (progress.completed / progress.total) * 100))
    : 0;
  const busy = ["starting", "running", "saving"].includes(status);
  const saving =
    busy && (status === "saving" || stage === "saving" || percent === 100);
  const current = saving ? 2 : stage === "simulating" ? 1 : 0;
  const text = saving
    ? labels.saving
    : status === "running" && current === 0
      ? labels.starting
      : labels[status];
  const star = "M0 -24 Q5 -5 22 0 Q5 5 0 26 Q-5 5 -22 0 Q-5 -5 0 -24Z";
  const orbit = (front: boolean) => (
    <g clipPath={`url(#${id}-${front ? "front" : "back"})`}>
      <ellipse
        cx="220"
        cy="211"
        rx="107"
        ry="31"
        fill="none"
        stroke="var(--workbench-orbit-track)"
        strokeWidth="3"
      />
      <g className="orbit-particle">
        <circle r="6" fill={`url(#${id}-sphere)`} />
      </g>
    </g>
  );
  return (
    <div
      className="simulation-orbit"
      data-status={status}
      data-motion={busy && active && visible ? "running" : "paused"}
    >
      <div
        className="sr-only"
        role="progressbar"
        aria-label="模拟次数进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${text}，${progress?.completed ?? 0} / ${progress?.total ?? 0} 次`}
      />
      <svg viewBox="0 0 440 420" aria-hidden="true" focusable="false">
        <defs>
          {cards.map(({ color }) => (
            <linearGradient
              key={color}
              id={`${id}-${color}-face`}
              x2="1"
              y2="1"
            >
              <stop stopColor="var(--workbench-surface)" />
              <stop
                offset="1"
                stopColor={`var(--workbench-card-${color}-surface)`}
              />
            </linearGradient>
          ))}
          <radialGradient id={`${id}-sphere`} cx="30%" cy="25%" r="75%">
            <stop stopColor="var(--workbench-card-gold-highlight)" />
            <stop offset=".35" stopColor="var(--workbench-card-gold)" />
            <stop offset="1" stopColor="var(--workbench-card-gold-shadow)" />
          </radialGradient>
          <clipPath id={`${id}-back`}>
            <rect width="440" height="211" />
          </clipPath>
          <clipPath id={`${id}-front`}>
            <rect y="211" width="440" height="209" />
          </clipPath>
        </defs>
        <circle className="orbit-ring-track" cx="220" cy="200" r="148" />
        <circle
          className="orbit-ring-progress"
          cx="220"
          cy="200"
          r="148"
          pathLength="100"
          strokeDasharray={`${percent} 100`}
          transform="rotate(-90 220 200)"
        />
        {orbit(false)}
        <g
          className="orbit-cards"
          key={status === "starting" ? "starting" : "rest"}
        >
          {cards.map(({ color, angle }) => (
            <g key={color} transform={`rotate(${angle} 220 264)`}>
              <g
                className={
                  status === "starting" ? "orbit-card-enter" : undefined
                }
              >
                <rect
                  x="177"
                  y="125"
                  width="86"
                  height="139"
                  rx="12"
                  fill={`url(#${id}-${color}-face)`}
                  stroke={`var(--workbench-card-${color})`}
                  strokeWidth="3"
                />
                <rect
                  x="183"
                  y="131"
                  width="74"
                  height="127"
                  rx="8"
                  fill="none"
                  stroke={`var(--workbench-card-${color})`}
                  strokeWidth="1"
                />
                <path
                  d={star}
                  transform="translate(220 194)"
                  fill={`var(--workbench-card-${color})`}
                />
              </g>
            </g>
          ))}
        </g>
        {orbit(true)}
        <text className="orbit-percent" x="220" y="309">
          {percent.toFixed(0)}%
        </text>
        <text className="orbit-count" x="220" y="370">
          {progress
            ? `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} 次`
            : "等待启动"}
        </text>
        <text className="orbit-status" x="220" y="402">
          {text}
        </text>
      </svg>
    </div>
  );
}
