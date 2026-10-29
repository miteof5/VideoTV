"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUser } from "@/lib/authz";
import { removeFile } from "@/lib/storage";

// Server Action 的选型理由：
// 新建/删除是「低频、表单式、提交完要刷新列表」的操作，
// 用 Server Action 不用手写 fetch、不用管 loading 状态、revalidate 也是自动的。
// 后面画布的自动保存、提交运行、SSE 订阅会改用 Route Handler（见 M2/M5）。

export async function createProject(formData: FormData) {
  const user = await getUser();
  if (!user) redirect("/sign-in");

  const raw = String(formData.get("name") ?? "").trim();
  const name = raw || "未命名项目";

  const project = await db.project.create({ data: { name, ownerId: user.id } });

  revalidatePath("/");
  redirect(`/projects/${project.id}`);
}

export async function deleteProject(formData: FormData) {
  const user = await getUser();
  if (!user) redirect("/sign-in");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  /*
   * 先确认这个项目是他的 —— 而且用**查不到就静默返回**的方式。
   *
   * 这里不能报错、不能给不同提示：这是个 Server Action，
   * 任何区别对待都会让「这个 id 存不存在」变得可探测。
   * 拿别人的 id 打过来，效果和打一个不存在的 id 完全一样（什么也没发生）。
   */
  const project = await db.project.findFirst({
    where: { id, ownerId: user.id },
    select: { id: true },
  });
  if (!project) return;

  /*
   * 先删文件，再删记录。
   *
   * 数据库的级联只到 nodes / edges / runs / jobs —— Asset 加了 projectId 之后
   * 记录会被级联删掉，但**磁盘上的文件它管不到**。
   * 上一版就是这样漏的：库里 272 个资产、55MB，删了项目之后文件全留在原地，
   * 而没有任何地方能再找到它们（记录没了，资产库也看不到）。
   *
   * 顺序不能反：先删记录的话，文件就永远失去索引，变成谁也说不清的垃圾。
   */
  const assets = await db.asset.findMany({
    where: { projectId: id },
    select: { filePath: true },
  });
  await Promise.all(assets.map((a) => removeFile(a.filePath).catch(() => {})));

  // 级联删除由 Prisma schema 的 onDelete: Cascade 保证，
  // 项目下的 nodes / edges / runs / jobs / assets 会一起清掉
  await db.project.delete({ where: { id } });

  revalidatePath("/");
}
