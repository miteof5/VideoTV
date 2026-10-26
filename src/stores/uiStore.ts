"use client";

import { create } from "zustand";

/**
 * 纯 UI 的瞬时状态。
 *
 * ### 为什么它必须是一个独立的 store
 *
 * canvasStore 里每一次 set 都会把图标脏、触发 800ms 防抖落库；
 * 而拖拽每秒派发几十次变更。把「正在拖哪个节点」放进去，
 * 一次拖拽就会冲垮保存通道 —— 数据库里会多出一堆毫无意义的写。
 *
 * runStore 也不合适：它管的都是运行态，和拖拽毫无关系，
 * 混进去会让「运行态每秒变多次」这条本已棘手的约束更难维持。
 *
 * 所以单开一个 store，只放不会被持久化的东西。
 */
interface UiState {
  /** 正在被拖动的节点 id，没有则为 null */
  draggingId: string | null;
  setDragging: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  draggingId: null,
  setDragging: (id) => set({ draggingId: id }),
}));
