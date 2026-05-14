import { ImportButton } from './ImportButton';
import { ReplayButton } from './ReplayButton';
import type { NormalizedVisualizeData } from '../types/visualize_input';

interface TopBarProps {
  data: NormalizedVisualizeData | null;
  is_animating: boolean;
  on_file_import: (file: File) => void;
  on_replay: () => void;
}

export function TopBar({
  data,
  is_animating,
  on_file_import,
  on_replay,
}: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="title-stack">
        <div className="section-kicker">CDF ANALYSIS</div>
        <h1>{data?.title ?? '抽卡模拟 CDF 分析'}</h1>
        <p>
          {data
            ? `模拟目标：${data.target} · 实际模拟抽数：${data.draw_counts_display}`
            : '导入模拟器输出 JSON 后生成结果页面'}
        </p>
      </div>
      <div className="top-actions" aria-label="数据操作">
        <ReplayButton
          disabled={!data}
          is_animating={is_animating}
          on_replay={on_replay}
        />
        <ImportButton
          compact={Boolean(data)}
          disabled={is_animating}
          on_file_import={on_file_import}
        />
      </div>
    </header>
  );
}
