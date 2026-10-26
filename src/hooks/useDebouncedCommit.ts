"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 输入框的「本地草稿 + 防抖写回」。
 *
 * ### 为什么不直接把输入框受控绑到 store（value={data.prompt}）？
 *
 * 1. **每敲一个字符都会写 store** → `nodes` 数组换新引用 → 整张画布重渲染。
 *    节点少时没感觉，画布上有几十个节点时打字就是肉眼可见的卡顿。
 * 2. **每次按键都被当成一次「图结构变更」**：revision 自增、dirty 置真。
 *    现在只是多几次保存，将来做 undo/redo 会变成一万个撤销步，
 *    做协作会把每个字符都广播出去。
 * 3. **受控组件的 value 来自外部**，一旦外部数据回灌（保存后重渲染、
 *    将来 M5 的 SSE 状态推送）正好撞在输入过程中，光标会被打断、甚至吞字。
 *
 * 所以：输入时只动本地 state（零延迟反馈），停手 delay 毫秒后才写回 store。
 *
 * ### 为什么还要 flush？
 *
 * 防抖意味着「最后一次输入未必已经提交」。如果用户在 400ms 内点了画布空白处，
 * 节点取消选中 → 面板卸载 → 那几个字就随组件一起消失了。
 * 所以失焦和卸载时都要强制补写一次。
 */
export function useDebouncedCommit<T>(
  external: T,
  commit: (value: T) => void,
  delay = 400
) {
  const [draft, setDraft] = useState<T>(external);

  const draftRef = useRef<T>(external);
  /** 最近一次已经写回外部的值，用来判断「是否真的变了」 */
  const committedRef = useRef<T>(external);
  /** 正在输入时，外部的任何回灌都不能覆盖用户刚敲的字 */
  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // commit 每次渲染都是新函数，用 ref 中转，避免把它塞进依赖导致定时器被反复重置
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (draftRef.current !== committedRef.current) {
      committedRef.current = draftRef.current;
      commitRef.current(draftRef.current);
    }
  }, []);

  const onChange = useCallback(
    (value: T) => {
      draftRef.current = value;
      setDraft(value);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (draftRef.current !== committedRef.current) {
          committedRef.current = draftRef.current;
          commitRef.current(draftRef.current);
        }
      }, delay);
    },
    [delay]
  );

  // 外部值真的变了才同步（初始化、将来的 undo、别处修改）。
  // 关键：`external !== committedRef.current` 这个判断挡掉了
  // 「我们自己刚提交上去、又被 props 原样传回来」的回环 —— 否则会无限抖动。
  useEffect(() => {
    if (focusedRef.current) return;
    if (external !== committedRef.current) {
      committedRef.current = external;
      draftRef.current = external;
      setDraft(external);
    }
  }, [external]);

  // 卸载时（面板收起、节点被删）把没来得及提交的草稿补写回去
  useEffect(() => {
    return () => flush();
  }, [flush]);

  return { draft, onChange, flush, focusedRef };
}
