import { ErrorPanel } from "./_components/ErrorPanel";

/**
 * 404。
 *
 * 触发点只有一处：`projects/[id]/page.tsx` 里项目查不到时调 `notFound()`。
 * 加这个文件之前它走的是 Next 默认 404 —— 白底黑字一行 "This page could
 * not be found"，在一个全黑的编辑器里突然跳出一块亮色，看着像崩了。
 */
export default function NotFound() {
  return (
    <ErrorPanel
      title="找不到这个页面"
      description="项目可能已经被删掉了，或者链接里的地址不对。回到列表看看现在有哪些项目。"
      homeLabel="回到项目列表"
    />
  );
}
