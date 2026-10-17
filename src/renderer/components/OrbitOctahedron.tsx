import { useEffect, useRef, useState } from "react";

type Vector3 = [number, number, number];

const SPIN_PERIOD_MS = 4800;
const RADIUS = 9;
const axis_length = Math.hypot(1, 0.65, 0.3);
const axis = [1, 0.65, 0.3].map((value) => value / axis_length);
const yaw = (25 * Math.PI) / 180;
const elevation = (15 * Math.PI) / 180;
const vertices: Vector3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const faces = [
  [0, 2, 4],
  [0, 2, 5],
  [0, 3, 4],
  [0, 3, 5],
  [1, 2, 4],
  [1, 2, 5],
  [1, 3, 4],
  [1, 3, 5],
];

function project([x, y, z]: Vector3, angle: number): Vector3 {
  // Rodrigues rotation about a spatial diagonal, then the fixed camera view.
  const [ax, ay, az] = axis;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const along_axis = (ax * x + ay * y + az * z) * (1 - cos);
  const rx = x * cos + (ay * z - az * y) * sin + ax * along_axis;
  const ry = y * cos + (az * x - ax * z) * sin + ay * along_axis;
  const rz = z * cos + (ax * y - ay * x) * sin + az * along_axis;
  const depth = -Math.sin(yaw) * rx + Math.cos(yaw) * rz;
  return [
    Math.cos(yaw) * rx + Math.sin(yaw) * rz,
    -Math.cos(elevation) * ry - Math.sin(elevation) * depth,
    Math.sin(elevation) * ry + Math.cos(elevation) * depth,
  ];
}

export function OrbitOctahedron({
  id,
  moving,
}: {
  id: string;
  moving: boolean;
}) {
  const elapsed = useRef(0);
  const [angle, set_angle] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous: number | null = null;
    const tick = (time: number) => {
      if (previous !== null) {
        elapsed.current = (elapsed.current + time - previous) % SPIN_PERIOD_MS;
        set_angle((-elapsed.current / SPIN_PERIOD_MS) * Math.PI * 2);
      }
      previous = time;
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      previous = null;
      if (!preference.matches) frame = requestAnimationFrame(tick);
    };
    preference.addEventListener("change", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", update);
    };
  }, [moving]);

  const projected = vertices.map((vertex) => project(vertex, angle));
  return (
    <g id={id} className="orbit-octahedron" transform="rotate(-12)">
      {faces.map((face, index) => {
        const points = face.map((vertex) => projected[vertex]);
        // The sum of a face's unit vertices gives its outward normal.
        const normal = [0, 1, 2].map(
          (component) =>
            points.reduce((sum, vertex) => sum + vertex[component], 0) /
            Math.sqrt(3),
        );
        if (normal[2] <= 0) return null;
        const light = Math.max(
          0,
          (-0.45 * normal[0] - 0.65 * normal[1] + 0.61 * normal[2]) /
            Math.hypot(0.45, 0.65, 0.61),
        );
        const dark = light < 0.5;
        const shade = dark ? "gold-shadow" : "gold";
        const lit = dark ? "gold" : "gold-highlight";
        const weight = (dark ? light : light - 0.5) * 200;
        return (
          <polygon
            key={index}
            points={points
              .map(
                ([x, y]) =>
                  `${(x * RADIUS).toFixed(3)},${(y * RADIUS).toFixed(3)}`,
              )
              .join(" ")}
            fill={`color-mix(in srgb, var(--workbench-card-${shade}), var(--workbench-card-${lit}) ${weight}%)`}
          />
        );
      })}
    </g>
  );
}
