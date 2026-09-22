import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// 這個 app 原本完全沒有 Error Boundary：任何一處 render 時丟出的例外，
// React 都會把整棵 tree 卸載掉，變成整頁空白（連側欄、登出按鈕都不見，
// 使用者只會看到一片空白，完全不知道發生什麼事）。這裡接住例外，
// 至少顯示一個可以重新整理的畫面，並把錯誤內容印到 console 方便除錯。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("未預期的畫面錯誤", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-sm font-medium text-slate-700">畫面發生未預期的錯誤，請重新整理再試一次。</p>
          <p className="max-w-md text-xs text-slate-400">{this.state.error.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            重新整理
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
