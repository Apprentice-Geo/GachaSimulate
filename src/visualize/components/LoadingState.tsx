export function LoadingState() {
  return (
    <div className="state-panel" data-testid="loading-state">
      <div className="loading-mark" aria-hidden="true" />
      <div>
        <h2>正在读取输入</h2>
        <p>解析 schema、统计量和 CDF 曲线数据。</p>
      </div>
    </div>
  );
}
