import type { ComponentProps } from "react";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "default" | "compact" | "inline";
};

export function Button({
  variant = "primary",
  size = "default",
  type = "button",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`workbench-button workbench-button--${variant} workbench-button--${size} ${className}`}
    />
  );
}
