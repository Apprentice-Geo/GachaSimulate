import { Component, type ReactNode } from "react";
import { ResultLoadPanel } from "./ResultLoadPanel";

type Props = {
  children: ReactNode;
  on_select: () => Promise<boolean>;
};

export class ResultErrorBoundary extends Component<
  Props,
  {
    error: string | null;
    loading: boolean;
  }
> {
  state = { error: null as string | null, loading: false };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  private select = async () => {
    this.setState({ loading: true });
    try {
      if (await this.props.on_select()) this.setState({ error: null });
    } catch (error) {
      this.setState({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.setState({ loading: false });
    }
  };

  render() {
    if (this.state.error)
      return (
        <section className="renderer-placeholder result-load-page">
          <ResultLoadPanel
            description="结果画面无法显示，请重新选择 GSR 文件。"
            loading={this.state.loading}
            error={this.state.error}
            on_select={() => void this.select()}
          />
        </section>
      );
    return this.props.children;
  }
}
