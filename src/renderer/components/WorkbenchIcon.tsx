import type { LucideIcon, LucideProps } from "lucide-react";

type WorkbenchIconProps = Omit<LucideProps, "size"> & {
  icon: LucideIcon;
  size: number;
};

export function WorkbenchIcon({
  icon: Icon,
  size,
  style,
  ...props
}: WorkbenchIconProps) {
  const length = `calc(var(--desktop-unit) * ${size})`;
  return (
    <Icon {...props} style={{ ...style, width: length, height: length }} />
  );
}
