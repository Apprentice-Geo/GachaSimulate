import { RotateCcw } from "lucide-react";

interface ReplayButtonProps {
  disabled: boolean;
  is_animating: boolean;
  on_replay: () => void;
}

export function ReplayButton({
  disabled,
  is_animating,
  on_replay,
}: ReplayButtonProps) {
  return (
    <button
      className="icon-button"
      data-testid="replay-animation"
      disabled={disabled || is_animating}
      title="重新绘制动画"
      type="button"
      onClick={on_replay}
    >
      <RotateCcw aria-hidden="true" size={20} strokeWidth={2} />
    </button>
  );
}
