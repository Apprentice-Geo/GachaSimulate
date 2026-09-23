import { Store } from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "../components/Button";
import type {
  ConfigRepositoryState,
  RepositoryConfig,
} from "../../shared/installed_config";

const repository_status: Record<
  RepositoryConfig["status"],
  { label: string; action: string | null }
> = {
  available: { label: "可安装", action: "安装" },
  installed: { label: "已安装", action: null },
  update_available: { label: "可更新", action: "更新" },
  removed: { label: "已从源移除", action: null },
};

const repository_sources = [
  { id: "official", label: "官方仓库" },
  { id: "local", label: "本地目录" },
] as const;
type RepositorySource = (typeof repository_sources)[number]["id"];

export function ConfigRepositoryPage() {
  const [source, set_source] = useState<RepositorySource>("official");
  const [state, set_state] = useState<ConfigRepositoryState | null>(null);
  const [busy_id, set_busy_id] = useState<string | null>(null);
  const [official_message, set_official_message] =
    useState("正在读取配置状态…");
  const [local_message, set_local_message] = useState("");
  const [official_error, set_official_error] = useState<string | null>(null);
  const [local_error, set_local_error] = useState<string | null>(null);

  const run = async (
    target: RepositorySource,
    label: string,
    operation: () => Promise<ConfigRepositoryState>,
    id: string | null = null,
  ) => {
    set_busy_id(id ?? label);
    const set_message =
      target === "official" ? set_official_message : set_local_message;
    const set_error =
      target === "official" ? set_official_error : set_local_error;
    set_error(null);
    set_message(
      label === "刷新"
        ? "正在刷新官方目录；若远端限流，最多等待 30 秒后重试一次，应用其他功能不受影响。"
        : `${label}中…`,
    );
    try {
      set_state(await operation());
      set_message(`${label}完成。`);
    } catch (reason) {
      set_error(reason instanceof Error ? reason.message : String(reason));
      set_message(`${label}失败，请按提示重试。`);
    } finally {
      set_busy_id(null);
    }
  };

  useEffect(() => {
    void window.desktopApi
      .getConfigRepositoryState()
      .then((initial) => {
        set_state(initial);
        set_official_message(
          "正在刷新官方目录；若远端限流，最多等待 30 秒后重试一次，应用其他功能不受影响。",
        );
        return window.desktopApi.refreshConfigRepository();
      })
      .then((refreshed) => {
        set_state(refreshed);
        set_official_message(
          refreshed.sourceError
            ? "官方目录离线；已安装和本地配置仍可使用。"
            : "官方目录已刷新。",
        );
      })
      .catch((reason: unknown) => {
        set_official_error(
          reason instanceof Error ? reason.message : String(reason),
        );
        set_official_message("配置状态读取失败。");
      });
  }, []);

  const action = (config: RepositoryConfig) => {
    if (config.status === "available")
      return run(
        "official",
        "安装",
        () => window.desktopApi.installConfig(config.id),
        config.id,
      );
    if (config.status === "update_available")
      return run(
        "official",
        "更新",
        () => window.desktopApi.updateConfig(config.id),
        config.id,
      );
  };
  const repository_counts = {
    installed:
      state?.official.filter(({ status }) => status !== "available").length ??
      0,
    update:
      state?.official.filter(({ status }) => status === "update_available")
        .length ?? 0,
    available:
      state?.official.filter(({ status }) => status === "available").length ??
      0,
  };

  return (
    <section
      className="renderer-placeholder repository-page"
      aria-labelledby="config-repository-title"
    >
      <header className="page-heading repository-header">
        <div className="renderer-placeholder-mark" aria-hidden="true">
          <Store size={20} />
        </div>
        <div>
          <p className="renderer-eyebrow">CONFIGURATION CATALOG</p>
          <h1 className="page-title" id="config-repository-title">
            配置仓库
          </h1>
        </div>
      </header>

      <div
        className="repository-source-switch"
        role="group"
        aria-label="配置来源"
      >
        {repository_sources.map((entry) => (
          <Button
            key={entry.id}
            variant={source === entry.id ? "primary" : "secondary"}
            aria-pressed={source === entry.id}
            onClick={() => set_source(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      <div className={`repository-overview repository-overview--${source}`}>
        <dl>
          {source === "official" ? (
            <>
              <div>
                <dt>已安装</dt>
                <dd>{repository_counts.installed}</dd>
              </div>
              <div>
                <dt>可更新</dt>
                <dd>{repository_counts.update}</dd>
              </div>
              <div>
                <dt>可安装</dt>
                <dd>{repository_counts.available}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>配置数</dt>
              <dd>{state?.localConfigs.length ?? 0}</dd>
            </div>
          )}
        </dl>
        {source === "local" && (
          <p
            className="repository-overview-directory"
            title={state?.localDirectory ?? undefined}
          >
            {state?.localDirectory ?? "尚未选择目录"}
          </p>
        )}
        <div className="repository-status" role="status">
          {source === "official" ? official_message : local_message}
        </div>
        {source === "official" ? (
          <Button
            disabled={busy_id !== null}
            onClick={() =>
              void run("official", "刷新", () =>
                window.desktopApi.refreshConfigRepository(true),
              )
            }
          >
            刷新官方目录
          </Button>
        ) : (
          <Button
            disabled={busy_id !== null}
            onClick={() =>
              void run("local", "选择目录", () =>
                window.desktopApi.selectLocalConfigDirectory(),
              )
            }
          >
            选择本地目录
          </Button>
        )}
      </div>
      {source === "official" && (official_error || state?.sourceError) && (
        <div className="simulation-error" role="alert">
          {official_error ?? `官方目录：${state?.sourceError}`}
        </div>
      )}
      {source === "local" && local_error && (
        <div className="simulation-error" role="alert">
          {local_error}
        </div>
      )}

      {source === "official" ? (
        <section
          className="repository-source official-source"
          aria-labelledby="official-source-title"
        >
          <div className="repository-source-heading">
            <div>
              <span className="source-badge source-installed">官方配置</span>
              <h2 id="official-source-title">官方目录</h2>
            </div>
            <span>{state?.official.length ?? 0} 项</span>
          </div>
          <div className="repository-list">
            {state?.official.length ? (
              state.official.map((config) => {
                const status = repository_status[config.status];
                return (
                  <article
                    className="repository-card"
                    data-status={config.status}
                    key={config.id}
                  >
                    <div>
                      <div className="repository-card-title">
                        <h3>{config.name}</h3>
                        <span>{status.label}</span>
                      </div>
                      <code>{config.id}</code>
                      <p>{config.description || "暂无说明"}</p>
                    </div>
                    <div className="repository-card-actions">
                      {status.action && (
                        <Button
                          className="repository-action"
                          type="button"
                          disabled={busy_id !== null}
                          onClick={() => void action(config)}
                        >
                          {busy_id === config.id
                            ? `${status.action}中…`
                            : status.action}
                        </Button>
                      )}
                      {config.status !== "available" && (
                        <Button
                          className="repository-action"
                          variant="secondary"
                          type="button"
                          disabled={busy_id !== null}
                          onClick={() =>
                            void run(
                              "official",
                              "卸载",
                              () =>
                                window.desktopApi.uninstallConfig(config.id),
                              config.id,
                            )
                          }
                        >
                          卸载
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })
            ) : (
              <p className="repository-empty">刷新官方目录以查看可安装配置。</p>
            )}
          </div>
        </section>
      ) : (
        <section
          className="repository-source local-source"
          aria-labelledby="local-source-title"
        >
          <div className="repository-source-heading">
            <div>
              <span className="source-badge source-local">本地配置</span>
              <h2 id="local-source-title">本地目录</h2>
            </div>
            <span>{state?.localConfigs.length ?? 0} 项</span>
          </div>
          {state?.localError && (
            <div className="simulation-error" role="alert">
              {state.localError}
            </div>
          )}
          <div className="local-config-list">
            {state?.localConfigs.map((config) => (
              <span key={config.id}>
                <strong>{config.name}</strong>
                <code>{config.id}</code>
              </span>
            ))}
            {state?.localDirectory && state.localConfigs.length === 0 && (
              <p className="repository-empty">目录中没有通过校验的配置。</p>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
