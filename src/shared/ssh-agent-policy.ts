export const SSH_REMOTE_EDITING_RULES = [
  '文件系统边界：目标项目只存在于 SSH 远端；当前 Agent 所在的本地工作目录、文件工具和本地 Shell 都不是目标项目。',
  '禁止使用本地 apply_patch、编辑器、重定向、本地 Python/PowerShell 或其他本地文件 API 直接创建或修改目标文件；唯一例外是 wmux ssh-file checkout 返回的系统临时暂存文件，它不是本地项目副本。',
  '所有项目探测、文件读写、格式化、构建和测试都必须作为命令发送到目标 SSH 终端，并由远端 Shell 执行；路径、引号、管道、重定向和临时文件必须遵循远端实际 Shell 与操作系统语法。',
  '首次写入前先在远端确认 pwd 和目标路径。小改动可使用远端已有工具；长文本或复杂改动必须执行 wmux ssh-file checkout --surface <SSH终端ID> --path <远端绝对路径>（也接受 --surface=<id> --path=<路径>）。只编辑返回的 stagingPath，再执行 wmux ssh-file commit --token <token>。新建文件增加 --create，放弃时执行 wmux ssh-file abort --token <token>。本机 Git Bash 或 WSL 把远端路径改写成 Windows 路径时，checkout 会还原成远端绝对路径，不要因此改用 base64 或远端 shell 分段写入。',
  '远端缺少某个工具时，先只读探测可用替代工具；不得把“远端没有 apply_patch”解释为可以改本地文件，也不得未经批准安装新工具。',
  'commit 成功会执行远端冲突检测和写后哈希校验并清理暂存目录；冲突或失败时不得声称已写入。之后仍须读取远端目标片段或远端 diff，行为变更还要在远端运行最相关验证。只有远端输出可作为完成证据。',
] as const;

/** A companion may omit the target, but an explicit target must match its binding. */
export function isSshCompanionReconnectTargetAllowed(
  boundTargetSurfaceId: string | undefined,
  requestedSurfaceId: string | undefined,
): boolean {
  if (!boundTargetSurfaceId) return false;
  const requested = requestedSurfaceId?.trim();
  return !requested || requested === boundTargetSurfaceId;
}
