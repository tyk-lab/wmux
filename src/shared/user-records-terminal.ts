export const USER_RECORDS_TERMINAL_NAME = '用户记录终端';
export const USER_RECORDS_TERMINAL_DIRECTORY = String.raw`K:\sync_code\Link_Folder_108952\toolbox\build\windows\x64\runner\Release`;
export const USER_RECORDS_TERMINAL_AGENT = 'codex' as const;
export const USER_RECORDS_TERMINAL_SKILL_NAME = 'user-data-management';
export const USER_RECORDS_TERMINAL_SKILL_RELATIVE_PATH = [
  '.agents',
  'skills',
  USER_RECORDS_TERMINAL_SKILL_NAME,
  'SKILL.md',
] as const;
export const USER_RECORDS_TERMINAL_STARTUP_INPUT = `$${USER_RECORDS_TERMINAL_SKILL_NAME}`;
