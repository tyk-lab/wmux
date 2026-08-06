import fs from 'fs';
import path from 'path';

const MAX_TASK_NAME_LENGTH = 64;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface FeishuDirectTaskDirectory {
  cwd: string;
  folderName: string;
  taskName: string;
  displayPath: string;
}

export function sanitizeFeishuDirectTaskName(value: string): string {
  let taskName = Array.from(
    value.normalize('NFKC'),
    (character) => character.charCodeAt(0) <= 31 ? '-' : character,
  ).join('')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_TASK_NAME_LENGTH)
    .replace(/[. ]+$/g, '');
  if (!taskName || taskName === '.' || taskName === '..') taskName = 'Codex任务';
  if (WINDOWS_RESERVED_NAME.test(taskName)) taskName = `任务-${taskName}`;
  return taskName;
}

function taskTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function createFeishuDirectTaskDirectory(
  desktopDirectory: string,
  requestedName: string,
  now = new Date(),
): FeishuDirectTaskDirectory {
  if (!path.isAbsolute(desktopDirectory)) throw new Error('桌面目录不是绝对路径。');
  const taskName = sanitizeFeishuDirectTaskName(requestedName);
  const root = path.join(desktopDirectory, 'wmux任务');
  fs.mkdirSync(root, { recursive: true });

  const baseName = `${taskName}-${taskTimestamp(now)}`;
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const folderName = attempt === 1 ? baseName : `${baseName}-${attempt}`;
    const cwd = path.join(root, folderName);
    try {
      fs.mkdirSync(cwd);
      return {
        cwd,
        folderName,
        taskName,
        displayPath: `桌面\\wmux任务\\${folderName}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同名任务目录过多，请稍后重试。');
}
