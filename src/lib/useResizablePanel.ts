import { useCallback, useEffect, useRef, useState } from "react";

// 側欄可拖拉調整寬度／收合成窄 icon 列，只在桌面版使用；寬度跟收合狀態存瀏覽器
// localStorage（brainstorms/2026-09-22-sidebar-resize-ai-context.md Q1），換裝置或清
// 瀏覽器資料會重置回預設值，這是已經確認接受的取捨。

interface UseResizablePanelOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  // 面板在畫面上的位置：往右拖拉手把時，"left" 面板變寬、"right" 面板變窄
  direction: "left" | "right";
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readStoredBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 私密瀏覽模式等情況 localStorage 可能不可用，放棄記憶即可，不影響畫面本身
  }
}

export function useResizablePanel(
  storageKey: string,
  { defaultWidth, minWidth, maxWidth, direction }: UseResizablePanelOptions,
) {
  const [width, setWidth] = useState(() => readStoredNumber(`${storageKey}:width`, defaultWidth));
  const [collapsed, setCollapsed] = useState(() => readStoredBool(`${storageKey}:collapsed`, false));
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => writeStored(`${storageKey}:width`, String(width)), [storageKey, width]);
  useEffect(() => writeStored(`${storageKey}:collapsed`, collapsed ? "1" : "0"), [storageKey, collapsed]);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragState.current) return;
      const delta = e.clientX - dragState.current.startX;
      const signedDelta = direction === "left" ? delta : -delta;
      setWidth(Math.min(maxWidth, Math.max(minWidth, dragState.current.startWidth + signedDelta)));
    },
    [direction, maxWidth, minWidth],
  );

  const stopDrag = useCallback(() => {
    dragState.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopDrag);
  }, [handlePointerMove]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      dragState.current = { startX: e.clientX, startWidth: width };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDrag);
    },
    [width, handlePointerMove, stopDrag],
  );

  return { width, collapsed, setCollapsed, startResize };
}

// 只在桌面版（Tailwind 的 md 斷點，768px）啟用拖拉調整/收合；手機版維持原本的
// 滑出式抽屜／聊天-工作區切換按鈕互動，不套用這裡的邏輯（Q6）。
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches,
  );

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = () => setIsDesktop(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isDesktop;
}
