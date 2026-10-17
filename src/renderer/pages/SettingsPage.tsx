import { WorkbenchIcon } from "../components/WorkbenchIcon";
import { ExternalLink, Moon, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { app_info, type AppLink } from "../../shared/app_info";
import { Button } from "../components/Button";
import type { WorkbenchTheme } from "../theme";

const links: Array<{ id: AppLink; label: string }> = [
  { id: "project", label: "项目主页" },
  { id: "issues", label: "问题反馈" },
  { id: "license", label: "开源许可证" },
  { id: "notices", label: "第三方声明" },
];

export function SettingsPage({
  theme,
  on_theme,
  theme_error,
}: {
  theme: WorkbenchTheme;
  on_theme: (theme: WorkbenchTheme) => void;
  theme_error: string | null;
}) {
  const [link_error, set_link_error] = useState<string | null>(null);
  const open_link = async (link: AppLink) => {
    set_link_error(null);
    try {
      await window.desktopApi.openAppLink(link);
    } catch {
      set_link_error("无法打开链接，请检查默认浏览器后重试。");
    }
  };

  return (
    <section
      className="renderer-placeholder settings-page"
      aria-labelledby="settings-title"
    >
      <header className="page-heading">
        <div className="renderer-placeholder-mark">
          <WorkbenchIcon icon={Settings} aria-hidden="true" size={24} />
        </div>
        <div>
          <p className="renderer-eyebrow">PREFERENCES</p>
          <h1 className="page-title" id="settings-title">
            设置
          </h1>
        </div>
      </header>
      <div className="settings-body">
        <section
          className="instrument-panel settings-panel"
          aria-labelledby="appearance-title"
        >
          <header className="panel-heading">
            <div>
              <p className="panel-kicker">APPEARANCE</p>
              <h2 className="panel-title" id="appearance-title">
                外观
              </h2>
            </div>
          </header>
          <div className="settings-appearance">
            <div>
              <h3 className="settings-label">工作台主题</h3>
              <p className="settings-description">
                选择习惯的明暗风格，自动记住本次设置。
              </p>
            </div>
            <fieldset className="settings-theme-options">
              <legend className="sr-only">工作台主题</legend>
              {(
                [
                  { value: "light", label: "浅色", icon: Sun },
                  { value: "dark", label: "深色", icon: Moon },
                ] as const
              ).map(({ value, label, icon: Icon }) => (
                <label key={value} className="settings-theme-option">
                  <input
                    type="radio"
                    name="workbench-theme"
                    value={value}
                    checked={theme === value}
                    onChange={() => on_theme(value)}
                  />
                  <WorkbenchIcon icon={Icon} aria-hidden="true" size={18} />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          </div>
          <p className="settings-description settings-theme-note">
            结果可视化与导出素材保持深色画面。
          </p>
          {theme_error && (
            <p role="alert" className="simulation-error">
              {theme_error}
            </p>
          )}
        </section>
        <section
          className="instrument-panel settings-panel"
          aria-labelledby="software-title"
        >
          <header className="panel-heading">
            <div>
              <p className="panel-kicker">APPLICATION</p>
              <h2 className="panel-title" id="software-title">
                软件信息
              </h2>
            </div>
          </header>
          <h3 className="settings-app-name">{app_info.name}</h3>
          <p className="settings-description">
            可配置的 Monte Carlo
            抽卡模拟与结果可视化工具，用于分析物品数量分布、分位数与终止原因。
          </p>
          <dl className="settings-metadata">
            <div>
              <dt>版本</dt>
              <dd data-testid="app-version">{app_info.version}</dd>
            </div>
            <div>
              <dt>许可证</dt>
              <dd>{app_info.license}</dd>
            </div>
          </dl>
          <div className="settings-links" role="group" aria-label="项目链接">
            {links.map(({ id, label }) => (
              <Button
                key={id}
                variant="secondary"
                size="compact"
                onClick={() => void open_link(id)}
              >
                {label}
                <WorkbenchIcon
                  icon={ExternalLink}
                  aria-hidden="true"
                  size={15}
                />
              </Button>
            ))}
          </div>
          {link_error && (
            <p role="alert" className="simulation-error">
              {link_error}
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
