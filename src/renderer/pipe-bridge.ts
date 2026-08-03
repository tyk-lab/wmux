/**
 * pipe-bridge.ts — Exposes Zustand store operations as window.__wmux_* globals
 * so the main process can call them via executeJavaScript from V2 pipe handlers.
 */
import { useStore } from './store';
import { splitNode, getAllPaneIds, findLeaf, buildGridLayout, createLeaf } from './store/split-utils';
import { surfaceTerminalRegistry } from './hooks/useTerminal';
import { PaneId, SurfaceId, WorkspaceId, SurfaceType, SplitNode } from '../shared/types';
import {
  DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS,
  DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS,
  DEFAULT_SUPERVISOR_WORK_SCOPE,
  type SupervisorAutonomyPermission,
  type SupervisorForbiddenAction,
  type SupervisorWorkScope,
} from '../shared/supervisor-policy';
import { v4 as uuid } from 'uuid';
import { sendToSurface, SUPERVISOR_TUI_READY_DELAY_MS } from './supervisor/supervisor-engine';
import { appendSupervisorRecord } from './supervisor/recording';
import type { SupervisorDecision, SupervisorLane } from './store/supervisor-slice';
import {
  buildSupervisorBriefing,
  effectiveSupervisorTaskGoal,
  SUPERVISOR_TAB_TITLE,
  SUPERVISOR_WORKSPACE_TITLE,
  supervisorTabTitle,
} from './supervisor/protocol';
import { buildSupervisorLaunchCommand } from './supervisor/launch-command';

export function isSupervisorDecisionAuthorised(
  lane: Pick<SupervisorLane, 'supervisorSurfaceId'>,
  supervisorSurfaceId: string,
): boolean {
  return !!supervisorSurfaceId && lane.supervisorSurfaceId === supervisorSurfaceId;
}

export function isRemoteSshControlledLane(
  lane: Pick<SupervisorLane, 'remoteSshControl' | 'workspaceId'>,
  workspaces: ReadonlyArray<{ id: WorkspaceId; sshProfileId?: string }>,
): boolean {
  if (lane.remoteSshControl) return true;
  return !!lane.workspaceId
    && !!workspaces.find((workspace) => workspace.id === lane.workspaceId)?.sshProfileId;
}

/** Small reversible adjustments are autonomous; material proposals remain human-gated. */
export function isSupervisorProposalAllowed(outcome: string, proposalKind: string): boolean {
  if (!proposalKind) return true;
  if (proposalKind === 'route-adjustment') return outcome === 'continue' || outcome === 'rework';
  return (proposalKind === 'route-change' || proposalKind === 'important') && outcome === 'needs-human';
}

/** A supervisor may advance work only from a continuation/rework or a human proposal. */
export function isSupervisorNextAllowed(
  _mode: string,
  outcome: string,
  next: string,
  _autonomous = false,
): boolean {
  return !next || outcome === 'continue' || outcome === 'rework' || outcome === 'needs-human';
}

const AUTONOMOUS_BLOCKED_ACTIONS: Array<[RegExp, string]> = [
  [/(?:^|[\s;&|("'`])(?:rm|rmdir|del|erase|rd|ri|remove-item|clear-content|set-content|out-file)\b|删除|(?:覆盖|覆写)(?:.{0,8}(?:文件|数据)|\s+(?:[a-zA-Z]:|\\\\|\/|\.\.?[\\/]|[^\s]+\.[a-z0-9]{1,12}))/i, '删除或覆盖文件'],
  [/\bgit\b[^;；&|\r\n]{0,200}\b(?:push|reset\s+--hard|clean|remote\s+(?:add|remove|set-url))\b/i, '推送或重写 Git 历史'],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine)\s+(?:publish|release)\b/i, '发布软件包'],
  [/\bgh\s+(?:pr\s+(?:create|merge|close)|release\s+create)\b/i, '对外提交或发布'],
  [/\b(?:curl|invoke-restmethod|invoke-webrequest|irm|iwr)\b[^\r\n]{0,300}(?:-x|--request|-method)\s*(?:delete|post|put|patch)\b/i, '外部写操作'],
  [/\b(?:deploy|release|publish)\b|部署|发布|对外提交/i, '部署、发布或对外提交'],
  [/\b(?:kubectl|helm|terraform|pulumi|aws|az|gcloud)\b/i, '云端或生产环境操作'],
  [/\b(?:production|prod)\b|生产环境|线上环境/i, '生产环境操作'],
  [/(?:\b(?:read|show|print|export|write|modify|change|update|delete|rotate|reset)\b|读取|显示|打印|导出|写入|修改|更改|更新|删除|轮换|重置).{0,24}(?:\b(?:credential|secret|token|password|api[ _-]?key)\b|凭据|密钥|令牌|密码)|(?:\b(?:credential|secret|token|password|api[ _-]?key)\b|凭据|密钥|令牌|密码).{0,24}(?:\b(?:value|content|change|update|delete|rotate|reset)\b|值|内容|变更|更新|删除|轮换|重置)/i, '凭据或权限变更'],
  [/(?:^|\s)(?:sudo|runas)\b|\bstart-process\b[^\n]*\s-verb\s+runas\b|\b(?:set-executionpolicy|takeown|icacls|set-acl|new-localuser|add-localgroupmember)\b|管理员权限|系统权限/i, '管理员权限或系统权限变更'],
];

/** Returns why an AI-proposed action must remain a human decision. */
export function autonomousActionBlockReason(action: string): string | null {
  const text = action.trim();
  if (!text) return null;
  for (const [pattern, reason] of AUTONOMOUS_BLOCKED_ACTIONS) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

const REMOTE_SSH_HUMAN_ACTIONS: Array<[RegExp, string]> = [
  [
    /(?:^|[\s;&|])(?:unlink|shred)\b|\bfind\b[^\r\n]{0,240}\s-delete\b|\brsync\b[^\r\n]{0,240}\s--delete\b|\btruncate\b[^\r\n]{0,120}\s-s\s*0\b|\bgit\b[^\r\n]{0,160}\brestore\b|\bgit\b[^\r\n]{0,160}\bcheckout\s+--(?:\s|$)|\b(?:cp|mv)\b[^\r\n]{0,160}\s-f\b|\b(?:move-item|copy-item)\b[^\r\n]{0,160}\s-force\b|清理.{0,20}(?:文件|目录|日志|缓存|数据)/i,
    '删除或破坏性覆盖远程文件',
  ],
  [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade|remove|uninstall)\b|\b(?:pip|pip3|uv)\s+(?:install|uninstall|sync|add|remove|upgrade)\b|\bcargo\s+(?:install|uninstall|add|remove|update)\b|\bgo\s+(?:get|install)\b|\bdotnet\s+(?:add|remove)(?:\s+\S+)?\s+package\b|\b(?:apt(?:-get)?|yum|dnf|pacman|zypper|apk|brew|choco|winget|scoop)\s+(?:install|remove|uninstall|update|upgrade|add)\b|(?:安装|卸载|升级|更新).{0,12}(?:软件包|系统包|依赖)/i,
    '安装、卸载或升级软件包',
  ],
  [
    /\b(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\b|\bsc(?:\.exe)?\s+(?:start|stop|config|create|delete|failure)\b|\b(?:start-service|stop-service|restart-service|set-service|new-service|kill|pkill|killall|taskkill|stop-process|start-process)\b|\b(?:reboot|shutdown|halt|poweroff|restart-computer|stop-computer)\b|\b(?:docker|podman)\s+(?:stop|kill|restart|rm|rmi|system\s+prune)\b|\b(?:docker|podman)\s+compose\s+(?:down|stop|restart|rm)\b|\b(?:pm2|supervisorctl)\s+(?:start|stop|restart|reload|delete)\b|(?:启动|停止|重启|重载|启用|禁用).{0,10}(?:服务|进程|守护进程)|(?:终止|杀死).{0,10}(?:进程|任务)/i,
    '服务、进程或主机状态变更',
  ],
  [
    /\bpsmux\b[^\r\n]{0,240}\bsend-keys\b[^\r\n]{0,120}(?:\bC-c\b|\^C|Ctrl\+C)/i,
    '向 SSH 任务终端发送中断信号',
  ],
  [
    /(?:\b(?:approve|allow|confirm)\b|确认|批准|允许|授权).{0,32}(?:\b(?:permission|privilege|elevation)\b|权限|提权)|(?:\b(?:permission|privilege|elevation)\b|权限|提权).{0,32}(?:\b(?:approve|allow|confirm)\b|确认|批准|允许|授权)/i,
    'SSH 远端权限批准',
  ],
  [
    /\b(?:chmod|chown|chgrp|setfacl|setcap|usermod|useradd|userdel|groupadd|groupdel|passwd|visudo|mount|umount|mkfs(?:\.\w+)?|fdisk|parted|iptables|nft|ufw|firewall-cmd|semanage|setenforce|sysctl)\b|\b(?:icacls|set-acl|takeown|netsh|bcdedit|diskpart)\b|(?:修改|变更|调整).{0,10}(?:权限|所有者|用户组|防火墙|系统配置)|(?:挂载|卸载|格式化).{0,10}(?:磁盘|文件系统|分区)/i,
    '权限、账户、网络或系统配置变更',
  ],
  [
    /\b(?:drop|truncate)\s+(?:database|schema|table)\b|\bdelete\s+from\b|\balter\s+(?:database|schema|table)\b|(?:删除|清空).{0,10}(?:数据库|数据表|远程数据)/i,
    '远程数据库破坏性变更',
  ],
];

/** Returns why an SSH-controlling worker must hand an otherwise allowed action to a human. */
export function remoteSshActionBlockReason(action: string): string | null {
  const text = action.trim();
  if (!text) return null;
  const generalBlockReason = autonomousActionBlockReason(text);
  if (generalBlockReason) return generalBlockReason;
  for (const [pattern, reason] of REMOTE_SSH_HUMAN_ACTIONS) {
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

const CONFIGURED_FORBIDDEN_ACTIONS: Record<SupervisorForbiddenAction, [RegExp, string]> = {
  'new-dependencies': [
    /\bnpm\s+(?:i|install|update)\b|\b(?:pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade)\b|\b(?:cargo|pip|uv)\s+(?:install|add|update|upgrade)\b|\bgo\s+get\b|\bdotnet\s+add(?:\s+\S+)?\s+package\b|\bcomposer\s+require\b|新增.{0,12}依赖|升级.{0,12}依赖/i,
    '新增或升级第三方依赖',
  ],
  'public-api-change': [
    /\b(?:breaking\s+change|public\s+api)\b|改变.{0,16}(?:对外|公共).{0,8}(?:API|接口|协议)|破坏.{0,8}兼容/i,
    '改变对外 API、协议或兼容行为',
  ],
  'large-refactor': [
    /大范围.{0,8}重构|跨模块.{0,8}(?:重构|改写)|目录迁移|全量重写|rewrite\s+(?:all|entire)/i,
    '大范围重构或目录迁移',
  ],
  'weaken-tests': [
    /删除.{0,12}测试|跳过.{0,12}测试|弱化.{0,12}(?:测试|验收)|\b(?:disable|skip|remove)\b.{0,24}\btests?\b/i,
    '删除、跳过或弱化测试',
  ],
  'build-release-config': [
    /(?:修改|编辑|调整|更新|改动|重写).{0,16}(?:构建|发布|部署).{0,8}配置|\b(?:modify|edit|update|change)\b.{0,24}\b(?:electron-builder|dockerfile|\.github[\\/]workflows)\b/i,
    '修改构建、发布或部署配置',
  ],
  'external-network': [
    /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|web[_-]?search)\b|访问外部网络|调用外部服务/i,
    '访问外部网络或调用外部服务',
  ],
};

function isNegatedMatch(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 64), index);
  const boundary = /[，。；;！？!?\n]|(?:但(?:是)?|不过|然而|而是|改为|然后|随后|接着|\bthen\b|\bbut\b|\binstead\b)/gi;
  let clauseStart = 0;
  for (const match of prefix.matchAll(boundary)) {
    clauseStart = (match.index ?? 0) + match[0].length;
  }
  const clausePrefix = prefix.slice(clauseStart);
  return /(?:不要|不得|禁止|避免|不可|不能|无需|无须)[^，。；;！？!?\n]{0,28}$/i.test(clausePrefix);
}

/** Returns a selected project restriction that matches the proposed action text. */
export function configuredActionBlockReason(
  action: string,
  forbiddenActions: readonly SupervisorForbiddenAction[],
): string | null {
  const text = action.trim();
  if (!text) return null;
  for (const forbidden of forbiddenActions) {
    const rule = CONFIGURED_FORBIDDEN_ACTIONS[forbidden];
    if (!rule) continue;
    const [pattern, reason] = rule;
    const matches = text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    for (const match of matches) {
      const actionOffset = Math.max(0, match[0].search(/[a-zA-Z\u3400-\u9fff]/u));
      if (!isNegatedMatch(text, (match.index ?? 0) + actionOffset)) return reason;
    }
  }
  return null;
}

function normalizeAbsolutePath(value: string): string | null {
  const normalized = value.trim().replace(/[),;!?]+$/, '').replace(/\\/g, '/');
  let prefix: string;
  let rest: string;

  const drive = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (drive) {
    prefix = `${drive[1].toLowerCase()}:`;
    rest = drive[2];
  } else if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    prefix = `//${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
    rest = parts.slice(2).join('/');
  } else if (normalized.startsWith('/')) {
    prefix = '';
    rest = normalized.slice(1);
  } else {
    return null;
  }

  const caseInsensitive = !!prefix;
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(caseInsensitive ? segment.toLowerCase() : segment);
  }
  const suffix = segments.join('/');
  if (!prefix) return `/${suffix}`;
  return suffix ? `${prefix}/${suffix}` : `${prefix}/`;
}

type ScopePathStyle = 'windows' | 'posix';

function absolutePathStyle(value: string): ScopePathStyle | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) return 'windows';
  return normalized.startsWith('/') ? 'posix' : null;
}

function pathMatches(action: string, pattern: RegExp): string[] {
  return [...action.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

function extractPathReferences(action: string, style: ScopePathStyle): { absolute: string[]; relative: string[] } {
  // URI paths are network destinations, not local filesystem references. They
  // are governed separately by the external-network restriction.
  const quotedAbsolute: string[] = [];
  const withoutStandaloneQuotedPaths = action.replace(/(["'])(.*?)\1/g, (whole, _quote: string, value: string) => {
    if (absolutePathStyle(value) === style) {
      quotedAbsolute.push(value);
      return ' ';
    }
    return whole;
  });
  const text = withoutStandaloneQuotedPaths.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>|]+/gi, ' ');
  const boundary = '(?:^|[\\s(\\x22\\x27\\x60=,:])';
  const absolute = style === 'windows'
    ? [
        ...quotedAbsolute,
        ...pathMatches(text, new RegExp(`${boundary}([a-zA-Z]:[\\\\/][^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
        ...pathMatches(text, new RegExp(`${boundary}((?:\\\\\\\\|//)[^\\\\/\\s\\x22\\x27\\x60<>|]+[\\\\/][^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
        ...pathMatches(text, new RegExp('(?:^|[\\s(\\x22\\x27\\x60=,])(\\\\(?!\\\\)[^\\s\\x22\\x27\\x60<>|]+)', 'g')),
      ]
    : [
        ...quotedAbsolute,
        ...pathMatches(text, new RegExp(`${boundary}(/[^\\s\\x22\\x27\\x60<>|]*)`, 'g')),
      ];
  const relative = text
    .split(/[\s"'`=,:()]+/)
    .map((candidate) => candidate.replace(/[),;；!?！？]+$/, ''))
    .filter((candidate) => candidate.split(/[\\/]/).includes('..'));
  return { absolute, relative };
}

function resolveRelativePath(root: string, relative: string): string | null {
  return normalizeAbsolutePath(`${root.replace(/\/$/, '')}/${relative}`);
}

/** Explicit absolute paths outside the selected lane's immutable project root are never autonomous. */
export function workScopeBlockReason(
  action: string,
  workScope: SupervisorWorkScope,
  projectDir?: string,
): string | null {
  const root = projectDir?.trim();
  if (!root) return action.trim() ? '当前终端未上报工程文件夹' : null;
  const normalizedRoot = normalizeAbsolutePath(root);
  if (!normalizedRoot) return action.trim() ? '当前终端工程文件夹不是可校验的绝对路径' : null;
  const style = absolutePathStyle(root);
  if (!style) return action.trim() ? '当前终端工程文件夹不是可校验的绝对路径' : null;
  if (/\$(?:env:)?[a-z_][\w]*[\\/]|%[a-z_][\w]*%[\\/]|(?:^|\s)~[\\/]/i.test(action)) {
    return '使用了无法静态校验的工程外路径变量';
  }
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  const references = extractPathReferences(action, style);
  const outside = references.absolute.find((candidate) => {
    const normalized = normalizeAbsolutePath(candidate);
    return !!normalized && normalized !== normalizedRoot && !normalized.startsWith(rootPrefix);
  });
  if (outside) return '引用了当前工程文件夹之外的绝对路径';
  const traversesOutside = references.relative.some((candidate) => {
    const normalized = resolveRelativePath(normalizedRoot, candidate);
    return !!normalized && normalized !== normalizedRoot && !normalized.startsWith(rootPrefix);
  });
  if (traversesOutside) return '通过相对路径引用了当前工程文件夹之外的位置';
  if (workScope !== 'project' && /(?:全仓|整个工程|所有文件|无关文件|顺手(?:清理|修改|重构)|\b(?:entire|whole)\s+(?:repo|project)\b)/i.test(action)) {
    return workScope === 'plan-defined' ? '动作超出了计划文件限定范围' : '动作超出了当前任务直接涉及的文件范围';
  }
  return null;
}

export function isAutonomousPermissionResponseAllowed(response: string): boolean {
  return /^(?:y|yes|allow|approve)$/i.test(response.trim());
}

interface SupervisorAgentStateView {
  state?: string;
  blockedReason?: string | null;
  blockedVersion?: number;
  blockedRequestId?: string | null;
  sessionId?: string | null;
  updatedAt?: number;
}

function isPermissionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { state: 'blocked' } {
  return state?.state === 'blocked'
    && /\b(?:permission|approval|allowance)\b|权限|授权/i.test(state.blockedReason || '');
}

function isQuestionBlockedState(
  state: SupervisorAgentStateView | undefined,
): state is SupervisorAgentStateView & { state: 'blocked' } {
  return state?.state === 'blocked'
    && /question|input|choice|choose|select|prompt|询问|选择|输入|问题|决定/i.test(state.blockedReason || '');
}

const USER_ONLY_DECISION = /\b(?:terms?|billing|payment|purchase|subscription|account|login|credential|secret|token|password|privacy|licen[cs]e|shipping|delivery|address|order)\b|条款|付费|支付|购买|账单|套餐|订阅|账号|账户|登录|凭据|密钥|令牌|密码|隐私|许可|收货|配送|地址|订单|业务取舍|用户偏好/i;
const TECHNICAL_DECISION = /\b(?:technical|implementation|code|test|build|compile|type|interface|adapter|algorithm|module|file|path)\b|技术|实现|代码|测试|构建|编译|类型|接口|适配|算法|模块|文件|路径/i;

function isLowRiskTechnicalQuestion(
  state: SupervisorAgentStateView | undefined,
  proposedAnswer: string,
): boolean {
  if (!isQuestionBlockedState(state)) return false;
  const blockedReason = state.blockedReason || '';
  return !USER_ONLY_DECISION.test(`${blockedReason}\n${proposedAnswer}`)
    && TECHNICAL_DECISION.test(blockedReason);
}

function blockedRequestAlreadyAnswered(lane: SupervisorLane, state: SupervisorAgentStateView): boolean {
  if (state.blockedRequestId) return lane.lastBlockedResponseId === state.blockedRequestId;
  return typeof state.blockedVersion === 'number'
    && lane.lastBlockedResponseVersion === state.blockedVersion;
}

function selectedAutonomyPermissions(value: unknown): readonly SupervisorAutonomyPermission[] {
  if (value === undefined) return DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS;
  return Array.isArray(value)
    ? value.filter((item): item is SupervisorAutonomyPermission =>
      (DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS as readonly unknown[]).includes(item))
    : [];
}

function inferredNextPermissions(next: string): SupervisorAutonomyPermission[] {
  const permissions: SupervisorAutonomyPermission[] = [];
  if (/选择.{0,12}方案|采用.{0,12}方案|方案\s*[A-Z]\b|\b(?:choose|select|adopt)\b.{0,20}\b(?:option|approach|solution)\b/i.test(next)) {
    permissions.push('technical-choice');
  }
  if (/改用|切换到|调整.{0,8}(?:路线|方案|实现)|替代方案|放弃.{0,16}(?:实现|方案|路线)|从头(?:重做|实现)|重新(?:设计|实现)|推翻|迁移到|全面重写|\b(?:switch|replace|alternative|discard|redesign|migrate|rewrite|start\s+over)\b/i.test(next)) {
    permissions.push('route-adjustment');
  }
  return permissions;
}

function requiredAutonomyPermissions(opts: {
  outcome: string;
  next: string;
  proposalKind: string;
  permissionCommand: string;
  permissionResponse: string;
  agentState?: SupervisorAgentStateView;
}): SupervisorAutonomyPermission[] {
  if (opts.outcome === 'needs-human') return [];
  if (opts.permissionCommand || opts.permissionResponse) return ['permission-confirm'];
  if (!opts.next) return [];
  const required = inferredNextPermissions(opts.next);
  if (opts.proposalKind === 'route-adjustment') required.push('route-adjustment');
  if (isLowRiskTechnicalQuestion(opts.agentState, opts.next)) required.push('technical-choice');
  if (required.length === 0) required.push('same-route-next');
  return [...new Set(required)];
}


function terminalScreenTail(surfaceId: string, lines = 24): string {
  const terminal = surfaceTerminalRegistry.get(surfaceId);
  if (!terminal) return '';
  const buffer = terminal.buffer.active;
  const out: string[] = [];
  for (let index = Math.max(0, buffer.length - lines); index < buffer.length; index++) {
    out.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return out.join('\n').trim();
}

function normalizedEvidenceText(value: string): string {
  return value.toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
}

export function permissionCommandMatchesEvidence(command: string, evidence: string): boolean {
  const normalizedCommand = normalizedEvidenceText(command);
  const normalizedEvidence = normalizedEvidenceText(evidence);
  if (normalizedCommand.length < 3 || !normalizedEvidence) return false;
  if (/^(?:permission|approval|allowance|command|request|权限|授权|批准|命令|请求)(?:\s+required)?$/i.test(normalizedCommand)) {
    return false;
  }
  return normalizedEvidence.includes(normalizedCommand);
}

const AUTONOMY_PERMISSION_LABELS: Record<SupervisorAutonomyPermission, string> = {
  'same-route-next': '继续原路线的低风险下一步',
  'technical-choice': '回答低风险技术问题或方案选择',
  'route-adjustment': '小范围可逆路线调整',
  'permission-confirm': '确认低风险权限请求',
};

interface RemoteSupervisorStart {
  action: 'start';
  terminals: string[];
  stopWhen: string;
  stopWhenKind: 'concrete' | 'direction';
  taskGoal?: string;
  taskDescription?: string;
  preconditions?: string;
  planFile?: string;
  autonomous: boolean;
  supervisorLaunchCmd?: string;
  supervisorModel?: string;
  supervisorReasoningEffort?: string;
  actor?: string;
}

interface RemoteTerminalTask {
  action: 'send';
  terminal: string;
  task: string;
  actor?: string;
}

function collectRemoteTerminals(tree: SplitNode, workspace: { id: WorkspaceId; title: string; cwd?: string; sshProfileId?: string }, out: Array<{
  surfaceId: SurfaceId; paneId: PaneId; workspaceId: WorkspaceId; workspaceTitle: string; projectDir?: string; label: string; remoteSshControl: boolean;
}>): void {
  if (tree.type !== 'leaf') {
    collectRemoteTerminals(tree.children[0], workspace, out);
    collectRemoteTerminals(tree.children[1], workspace, out);
    return;
  }
  for (const surface of tree.surfaces) {
    if (surface.type !== 'terminal') continue;
    const label = surface.customTitle?.trim() || surface.shell || 'terminal';
    if (label.startsWith(SUPERVISOR_TAB_TITLE) || label === 'AI Supervisor') continue;
    out.push({
      surfaceId: surface.id,
      paneId: tree.paneId,
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      projectDir: workspace.cwd || surface.currentCwd || surface.cwd,
      label,
      remoteSshControl: !!workspace.sshProfileId,
    });
  }
}

function remoteTerminalList(): Array<{
  surfaceId: SurfaceId; paneId: PaneId; workspaceId: WorkspaceId; workspaceTitle: string; projectDir?: string; label: string; remoteSshControl: boolean;
}> {
  const store = useStore.getState();
  const terminals: ReturnType<typeof remoteTerminalList> = [];
  for (const workspace of store.workspaces) collectRemoteTerminals(workspace.splitTree, workspace, terminals);
  const supervisorIds = new Set(store.supervisor.lanes.map((lane) => lane.supervisorSurfaceId).filter(Boolean));
  return terminals.filter((terminal) => !supervisorIds.has(terminal.surfaceId));
}

function remoteAudit(session: ReturnType<typeof useStore.getState>['supervisor'], lane: SupervisorLane | undefined, type: string, payload: Record<string, unknown>): void {
  if (lane) appendSupervisorRecord(session, lane, type, payload);
}

function startRemoteSupervisor(params: RemoteSupervisorStart): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  if (store.supervisor.active) return { ok: false, error: '当前已有进行中的 AI 监督；请先停止。', message: '' };
  const selectedIds = new Set(params.terminals);
  const candidates = remoteTerminalList().filter((terminal) => selectedIds.has(terminal.surfaceId));
  if (candidates.length !== selectedIds.size) return { ok: false, error: '包含不存在或不可监督的终端 ID；先执行 LIST 获取最新终端。', message: '' };
  if (!params.stopWhen.trim()) return { ok: false, error: '停止条件不能为空。', message: '' };
  if (candidates.some((candidate) => !candidate.projectDir)) return { ok: false, error: '所选终端缺少项目目录，无法写入审计记录。', message: '' };

  let supervisorWorkspace = store.workspaces.find((workspace) => workspace.id === store.supervisor.supervisorWorkspaceId);
  if (!supervisorWorkspace) {
    const workspaceId = store.createWorkspace({ title: SUPERVISOR_WORKSPACE_TITLE, pinned: true, splitTree: createLeaf(undefined, 'supervisor') });
    store.patchSupervisor({ supervisorWorkspaceId: workspaceId });
    supervisorWorkspace = useStore.getState().workspaces.find((workspace) => workspace.id === workspaceId);
  }
  const targetPaneId = supervisorWorkspace ? getAllPaneIds(supervisorWorkspace.splitTree)[0] : undefined;
  if (!supervisorWorkspace || !targetPaneId) return { ok: false, error: '无法创建专属监督工作区。', message: '' };

  const launchCmd = params.supervisorLaunchCmd || store.supervisor.supervisorLaunchCmd || 'codex';
  const supervisorModel = params.supervisorModel || '';
  const supervisorReasoningEffort = params.supervisorReasoningEffort || '';
  const launch = buildSupervisorLaunchCommand(launchCmd, supervisorModel, supervisorReasoningEffort);
  const lanes: SupervisorLane[] = candidates.map((candidate, index) => {
    const supervisorSurfaceId = store.addSurface(supervisorWorkspace!.id, targetPaneId!, 'terminal', {
      customTitle: supervisorTabTitle(candidate.label),
      cwd: candidate.projectDir,
      startupCommands: launch ? [launch] : undefined,
      transientSupervisor: true,
    });
    return {
      id: `lane-${index + 1}`,
      label: candidate.label,
      surfaceId: candidate.surfaceId,
      supervisorSurfaceId,
      paneId: candidate.paneId,
      workspaceId: candidate.workspaceId,
      workspaceTitle: candidate.workspaceTitle,
      remoteSshControl: candidate.remoteSshControl,
      projectDir: candidate.projectDir,
      scopeRoot: candidate.projectDir,
      enabled: true,
      steps: [], maxAutoSteps: 0, autoStepsUsed: 0, awaitingStopCheck: false, stopConfirmed: false,
      awaitingReview: false, autoDecisionLimitReached: false, autoDecisionsUsed: 0, pendingSupervisorDeliveries: [], currentTask: '', decisions: [],
    };
  });
  if (lanes.some((lane) => !lane.supervisorSurfaceId)) return { ok: false, error: '无法为所有终端创建专属监督 AI。', message: '' };
  store.patchSupervisor({
    mode: 'unified', taskGoal: params.taskGoal || '', taskDescription: params.taskDescription || '', preconditions: params.preconditions || '',
    stopWhen: params.stopWhen, stopWhenKind: params.stopWhenKind, planFilePath: params.planFile || '', planFileContent: '',
    supervisorLaunchCmd: launchCmd, supervisorModel, supervisorReasoningEffort, maxAutoSteps: 0,
    maxAutoDecisions: params.autonomous ? null : store.supervisor.maxAutoDecisions, autonomous: params.autonomous,
    autonomyPermissions: [...DEFAULT_SUPERVISOR_AUTONOMY_PERMISSIONS],
    workScope: DEFAULT_SUPERVISOR_WORK_SCOPE,
    forbiddenActions: [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS],
  });
  store.setSupervisorLanes(lanes);
  store.startSupervisor();
  const session = useStore.getState().supervisor;
  for (const lane of session.lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'start', terminals: params.terminals, autonomous: params.autonomous, actor: params.actor || 'unknown' });
  window.setTimeout(() => {
    const current = useStore.getState().supervisor;
    const states = (window as any).__wmux_getAgentStates?.() || {};
    for (const lane of current.lanes) {
      if (!lane.supervisorSurfaceId) continue;
      sendToSurface(lane.supervisorSurfaceId, buildSupervisorBriefing(current, { lane, state: String(states[lane.surfaceId]?.state || 'unknown') }), true);
    }
  // Codex and similar TUIs need to finish their initial render before a large
  // briefing is pasted; otherwise the following Enter can be swallowed by the
  // paste handler and leave the supervisor waiting at an unsubmitted prompt.
  }, SUPERVISOR_TUI_READY_DELAY_MS);
  return { ok: true, message: `已启动 AI 监督：${lanes.map((lane) => `${lane.label} (${lane.surfaceId})`).join('、')}` };
}

function sendRemoteTerminalTask(params: RemoteTerminalTask): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const terminal = remoteTerminalList().find((item) => item.surfaceId === params.terminal);
  if (!terminal) return { ok: false, error: '终端不存在或不可发送任务；请先执行 LIST 获取最新终端。', message: '' };
  const task = params.task.trim();
  if (!task) return { ok: false, error: '任务内容不能为空。', message: '' };

  sendToSurface(terminal.surfaceId, task, true);
  const session = useStore.getState().supervisor;
  const lane = session.lanes.find((item) => item.surfaceId === terminal.surfaceId);
  if (lane) store.updateLane(lane.id, { currentTask: task });
  remoteAudit(session, lane, 'supervisor.remote-command', { action: 'send-task', terminal: terminal.surfaceId, actor: params.actor || 'unknown', task });
  return { ok: true, message: `已向 ${terminal.label} 发送任务。` };
}

function decideRemoteSupervisor(approvalId: string, decision: 'approve' | 'reject' | 'stop', task?: string, actor?: string): { ok: boolean; message: string; error?: string } {
  const store = useStore.getState();
  const session = store.supervisor;
  if (!session.active) return { ok: false, error: '当前监督会话已停止，不能处理旧待决项。', message: '' };
  const approval = session.pendingApprovals.find((item) => item.id === approvalId);
  if (!approval) return { ok: false, error: '该待决项不存在、已过期或已处理。', message: '' };
  if (Date.now() - approval.createdAt > 24 * 60 * 60 * 1000) {
    store.rejectPending(approvalId);
    return { ok: false, error: '该待决项已超过 24 小时，已作废。', message: '' };
  }
  const lane = session.lanes.find((item) => item.id === approval.laneId);
  if (decision === 'stop') {
    store.rejectPending(approvalId);
    store.stopSupervisor('飞书人工决定停止监督');
    remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown' });
    return { ok: true, message: '已停止当前 AI 监督。' };
  }
  const followUpTask = task?.trim() || '';
  if (decision === 'approve' && !followUpTask) return { ok: false, error: '批准时需要填写后续任务。', message: '' };
  const delivery = [approval.text.trim(), followUpTask].filter(Boolean).join('\n\n');
  if (decision === 'approve' && delivery) sendToSurface(approval.surfaceId, delivery, session.submitEnter);
  if (decision === 'approve') store.approvePending(approvalId);
  else store.rejectPending(approvalId);
  if (lane && (approval.source === 'supervisor-route' || approval.source === 'supervisor-important')) {
    store.updateLane(lane.id, { awaitingReview: decision !== 'approve', autoDecisionLimitReached: false, autoDecisionsUsed: 0, ...(decision === 'approve' ? { currentTask: followUpTask } : {}) });
    remoteAudit(session, lane, 'supervisor.proposal.resolved', { approvalId, resolution: decision === 'approve' ? 'approved' : 'rejected', proposalKind: approval.proposalKind || 'important', text: decision === 'approve' ? delivery : undefined });
    if (decision === 'reject' && lane.supervisorSurfaceId) {
      sendToSurface(lane.supervisorSurfaceId, '[人工决定] 已拒绝该建议；请依据当前任务、计划约束和终端证据重新裁决。\n', true);
    }
  }
  remoteAudit(session, lane, 'supervisor.remote-decision', { approvalId, decision, actor: actor || 'unknown', task: decision === 'approve' ? followUpTask : undefined });
  return { ok: true, message: decision === 'approve' ? '已批准并发送后续任务。' : '已拒绝建议。' };
}

export function normalizedMaxAutoDecisions(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(20, parsed) : null;
}

export function reachesAutoDecisionLimit(
  lane: Pick<SupervisorLane, 'autoDecisionsUsed'>,
  maxAutoDecisions: unknown,
): boolean {
  const limit = normalizedMaxAutoDecisions(maxAutoDecisions);
  return limit !== null && (lane.autoDecisionsUsed ?? 0) + 1 >= limit;
}

/** Permission acknowledgements are audited but do not consume a judgment slot. */
export function nextSupervisorDecisionCount(current: number | undefined, permissionResponse: string): number {
  return (current ?? 0) + (permissionResponse ? 0 : 1);
}

export function initPipeBridge(): void {
  const w = window as any;

  // ─── Workspace ──────────────────────────────────────────────────────────────

  w.__wmux_createWorkspace = (params?: { title?: string; shell?: string; cwd?: string }) => {
    const store = useStore.getState();
    const id = store.createWorkspace({
      title: params?.title,
      shell: params?.shell,
      cwd: params?.cwd,
    });
    return { workspaceId: id };
  };

  w.__wmux_closeWorkspace = (id: string) => {
    useStore.getState().closeWorkspace(id as WorkspaceId);
  };

  w.__wmux_selectWorkspace = (id: string) => {
    useStore.getState().selectWorkspace(id as WorkspaceId);
  };

  w.__wmux_renameWorkspace = (id: string, title: string) => {
    useStore.getState().renameWorkspace(id as WorkspaceId, title);
  };

  w.__wmux_listWorkspaces = () => {
    const store = useStore.getState();
    return store.workspaces.map(ws => ({
      id: ws.id,
      title: ws.title,
      isActive: ws.id === store.activeWorkspaceId,
      cwd: ws.cwd,
      shell: ws.shell,
    }));
  };

  // Which workspace owns a given surface? Used by main to route browser commands
  // to a browser pane in the *caller agent's* workspace (issue #62). Returns the
  // active workspace id as a fallback when the surface isn't found.
  w.__wmux_getWorkspaceIdForSurface = (surfaceId: string) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) return ws.id;
      }
    }
    return store.activeWorkspaceId ?? null;
  };

  // All browser surface ids in a workspace. Main adopts an unbound one for a
  // caller (or creates a fresh pane) so each agent gets its own browser (#62).
  w.__wmux_listBrowserSurfaces = (workspaceId: string) => {
    const store = useStore.getState();
    const ws = store.workspaces.find(x => x.id === workspaceId);
    if (!ws) return [];
    const ids: string[] = [];
    for (const paneId of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, paneId);
      for (const s of leaf?.surfaces ?? []) {
        if (s.type === 'browser') ids.push(s.id);
      }
    }
    return ids;
  };

  // ─── Pane ───────────────────────────────────────────────────────────────────

  w.__wmux_splitPane = (params?: { direction?: string; type?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const paneIds = getAllPaneIds(ws.splitTree);
    const targetPaneId = paneIds[0];
    if (!targetPaneId) return null;

    const newPaneId = `pane-${uuid()}` as PaneId;
    const surfaceType = (params?.type || 'terminal') as SurfaceType;
    const direction = params?.direction === 'down' || params?.direction === 'vertical'
      ? 'vertical' : 'horizontal';

    const newTree = splitNode(ws.splitTree, targetPaneId, newPaneId, surfaceType, direction);
    store.updateSplitTree(wsId, newTree);

    const newLeaf = findLeaf(newTree, newPaneId);
    const surfaceId = newLeaf?.surfaces?.[0]?.id || null;

    // Apply a per-pane color scheme override to the freshly-created surface
    // so `wmux split --color-scheme prod` takes effect immediately.
    if (params?.colorScheme && surfaceId && newLeaf) {
      store.updateSurface(wsId, newPaneId, surfaceId as SurfaceId, { colorScheme: params.colorScheme });
    }

    return { paneId: newPaneId, surfaceId };
  };

  w.__wmux_closePane = (paneId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;

    // Reaping + tree surgery live in the store action (issue #65 fixed the
    // missing reap here; the last-pane case was still wrong in all three copies).
    store.closePane(wsId, paneId as PaneId);
  };

  w.__wmux_layoutGrid = (params: { count: number; type?: string; anchorSurfaceId?: string; anchorPaneId?: string; workspaceId?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const count = Math.max(1, Math.floor(params.count || 1));
    if (count < 2) return { newPaneIds: [], newPanes: [] };

    // Resolve the anchor pane: explicit paneId > surface lookup > first pane
    const paneIds = getAllPaneIds(ws.splitTree);
    let anchorPaneId: PaneId | undefined;

    if (params.anchorPaneId) {
      anchorPaneId = params.anchorPaneId as PaneId;
    } else if (params.anchorSurfaceId) {
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === params.anchorSurfaceId)) {
          anchorPaneId = pid;
          break;
        }
      }
    }
    if (!anchorPaneId) anchorPaneId = paneIds[0];
    if (!anchorPaneId) return null;

    const surfaceType = (params.type || 'terminal') as SurfaceType;
    const { tree: newTree, newPaneIds } = buildGridLayout(ws.splitTree, anchorPaneId, count, surfaceType);
    store.updateSplitTree(wsId, newTree);

    // Resolve surface IDs for the newly-created panes so callers can target them directly.
    const newPanes = newPaneIds.map(pid => {
      const leaf = findLeaf(newTree, pid);
      return {
        paneId: pid,
        surfaceId: leaf?.surfaces?.[0]?.id || null,
      };
    });

    return { newPaneIds, newPanes, anchorPaneId, cols: Math.ceil(Math.sqrt(count)), rows: Math.ceil(count / Math.ceil(Math.sqrt(count))) };
  };

  w.__wmux_listPanes = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    return paneIds.map(pid => {
      const leaf = findLeaf(ws.splitTree, pid);
      return {
        paneId: pid,
        surfaces: leaf?.surfaces?.map(s => ({ id: s.id, type: s.type })) || [],
        tabCount: leaf?.surfaces?.length || 0,
        activeSurfaceIndex: leaf?.activeSurfaceIndex ?? 0,
      };
    });
  };

  // ─── Surface ────────────────────────────────────────────────────────────────

  w.__wmux_createSurface = (params?: { type?: string; paneId?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;

    let paneId = params?.paneId as PaneId | undefined;
    if (!paneId) {
      const ws = store.workspaces.find(w => w.id === wsId);
      if (!ws) return null;
      const paneIds = getAllPaneIds(ws.splitTree);
      paneId = paneIds[0];
    }
    if (!paneId) return null;

    const type = (params?.type || 'terminal') as SurfaceType;
    const surfaceId = store.addSurface(wsId, paneId, type, { colorScheme: params?.colorScheme });
    if (!surfaceId) return null;
    return { surfaceId, paneId };
  };

  /**
   * Update an existing surface's color scheme. Lets users switch a running
   * pane to "prod" mid-session via `wmux surface set-color-scheme <id> prod`.
   */
  w.__wmux_setSurfaceColorScheme = (surfaceId: string, colorScheme: string | null) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      const paneIds = getAllPaneIds(ws.splitTree);
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
          store.updateSurface(ws.id, pid, surfaceId as SurfaceId, {
            colorScheme: colorScheme || undefined,
          });
          return { ok: true };
        }
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_closeSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.closeSurface(wsId, pid, surfaceId as SurfaceId);
        return;
      }
    }
  };

  w.__wmux_renameSurface = (surfaceId: string, title: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return { ok: false, error: 'No active workspace' };
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return { ok: false, error: 'Workspace not found' };
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
        store.renameSurface(wsId, pid, surfaceId as SurfaceId, title ?? '');
        return { ok: true };
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_focusSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const paneIds = getAllPaneIds(ws.splitTree);
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        const idx = leaf.surfaces.findIndex(s => s.id === surfaceId);
        if (idx >= 0) {
          store.selectSurface(wsId, pid, idx);
          return;
        }
      }
    }
  };

  w.__wmux_listSurfaces = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    const surfaces: Array<{ id: string; type: string; paneId: string; isActive: boolean }> = [];
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        leaf.surfaces.forEach((s, idx) => {
          surfaces.push({
            id: s.id,
            type: s.type,
            paneId: pid,
            isActive: idx === leaf.activeSurfaceIndex,
          });
        });
      }
    }
    return surfaces;
  };

  w.__wmux_getActiveSurfaceId = () => {
    const store = useStore.getState();
    const wsId = store.activeWorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;
    const paneIds = getAllPaneIds(ws.splitTree);
    if (paneIds.length === 0) return null;
    const leaf = findLeaf(ws.splitTree, paneIds[0]);
    if (!leaf?.surfaces?.length) return null;
    const idx = leaf.activeSurfaceIndex ?? 0;
    return leaf.surfaces[idx]?.id || null;
  };

  // Read a terminal's screen as plain text (surface.read_text / read-screen).
  // Reads the ACTIVE xterm buffer — alt buffer included, so a full-screen TUI
  // returns what is actually visible. `lines` counts back from the bottom of
  // the buffer (scrollback included); trailing blank lines are trimmed.
  w.__wmux_readScreen = (surfaceId?: string, lines?: number) => {
    const id = surfaceId || w.__wmux_getActiveSurfaceId?.();
    if (!id) return { error: 'No active surface' };
    const terminal = surfaceTerminalRegistry.get(id);
    if (!terminal) {
      return { error: `no terminal for surface ${id} (markdown/browser pane, another window, or closed)` };
    }
    const buf = terminal.buffer.active;
    const count = Math.min(Math.max(Math.floor(lines ?? 50), 1), 10000);
    const end = buf.length;
    const out: string[] = [];
    for (let i = Math.max(0, end - count); i < end; i++) {
      out.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return { text: out.join('\n'), lines: out.length, surfaceId: id };
  };

  // The dedicated supervisor terminal records its judgment through a silent CLI
  // call. Routing by surfaceId, not display label, keeps duplicate tab names
  // distinct inside the same workspace/session.
  w.__wmux_supervisorDecide = (params: any) => {
    const store = useStore.getState();
    const session = store.supervisor;
    const surfaceId = String(params?.surfaceId || '');
    const supervisorSurfaceId = String(params?.supervisorSurfaceId || '');
    const outcome = String(params?.outcome || '') as SupervisorDecision['outcome'];
    const reason = String(params?.reason || '').trim().slice(0, 1200);
    const next = String(params?.next || '').trim().slice(0, 4000);
    const proposalKind = String(params?.proposalKind || '').trim();
    const impact = String(params?.impact || '').trim().slice(0, 1200);
    const alternatives = String(params?.alternatives || '').trim().slice(0, 1200);
    const permissionCommand = String(params?.permissionCommand || '').trim().slice(0, 2000);
    const permissionResponse = String(params?.permissionResponse || '').trim().slice(0, 16);
    const valid = new Set(['continue', 'rework', 'complete', 'needs-human']);
    const proposalKinds = new Set(['route-change', 'important']);
    const lane = session.lanes.find((item) => item.surfaceId === surfaceId && item.enabled);
    if (!session.active || !lane || !isSupervisorDecisionAuthorised(lane, supervisorSurfaceId) || !valid.has(outcome)) return null;
    const remoteSshControl = isRemoteSshControlledLane(lane, store.workspaces);
    if (lane.autoDecisionLimitReached && !session.autonomous) {
      return { ok: false, error: '已达到自动判断上限，等待人工审阅后继续' };
    }
    // A supervisor must not smuggle a declared route/important proposal through
    // an auto-continue decision. Such proposals always stop for user consent.
    if (!isSupervisorProposalAllowed(outcome, proposalKind)) {
      return { ok: false, error: '小范围路线调整须使用 route-adjustment 配合 continue/rework；重大路线变更或重要建议必须使用 needs-human' };
    }
    if (proposalKind === 'route-adjustment' && !next) {
      return { ok: false, error: 'route-adjustment 必须携带明确的低风险 --next' };
    }
    if (!isSupervisorNextAllowed(session.mode, outcome, next, session.autonomous)) {
      return { ok: false, error: '只有 continue、rework 或 needs-human 可以携带 --next' };
    }
    if (
      session.mode === 'unified'
      && (outcome === 'continue' || outcome === 'rework')
      && !next
      && !permissionCommand
      && !permissionResponse
    ) {
      return { ok: false, error: '统一监督的 continue/rework 必须携带明确的 --next；无法安全推进时请使用 needs-human' };
    }
    const remoteNextBlockReason = remoteSshControl ? remoteSshActionBlockReason(next) : null;
    if (outcome !== 'needs-human' && remoteNextBlockReason) {
      return { ok: false, error: `SSH 远程控制终端禁止自动执行${remoteNextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const nextBlockReason = autonomousActionBlockReason(next);
    if (outcome !== 'needs-human' && nextBlockReason) {
      return { ok: false, error: `监督 AI 禁止自动执行${nextBlockReason}；请使用 needs-human 交给人工处理` };
    }
    const forbiddenActions = Array.isArray(session.forbiddenActions)
      ? session.forbiddenActions
      : [...DEFAULT_SUPERVISOR_FORBIDDEN_ACTIONS];
    const configuredNextBlockReason = configuredActionBlockReason(next, forbiddenActions);
    if (outcome !== 'needs-human' && configuredNextBlockReason) {
      return { ok: false, error: `该动作命中用户勾选的禁止事项：${configuredNextBlockReason}；请使用 needs-human` };
    }
    const scopeBlockReason = workScopeBlockReason(
      next,
      session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
      lane.scopeRoot || lane.projectDir,
    );
    if (outcome !== 'needs-human' && scopeBlockReason) {
      return { ok: false, error: `${scopeBlockReason}；超出工作范围的动作必须使用 needs-human` };
    }
    if (
      next
      && outcome !== 'needs-human'
      && session.workScope === 'plan-defined'
      && !session.planFilePath?.trim()
    ) {
      return { ok: false, error: '工作范围设为“仅计划文件定义范围”，但当前没有计划文件；请补充计划文件或使用 needs-human' };
    }
    const hasTaskContext = !!(
      effectiveSupervisorTaskGoal(session, lane)
      || lane.currentTask?.trim()
      || session.planFilePath?.trim()
      || (session.mode !== 'unified' && session.directInstructions?.trim())
      || (session.mode !== 'unified' && session.goal?.trim())
    );
    if (next && outcome !== 'needs-human' && !hasTaskContext) {
      return { ok: false, error: '当前没有任务目标、已捕获任务或计划文件；可继续停止裁决，但自主发送下一步必须交给人工' };
    }
    if (permissionCommand || permissionResponse) {
      if (remoteSshControl) {
        return { ok: false, error: 'SSH 远程控制终端的权限请求必须由人工确认，监督 AI 不得自动发送批准响应' };
      }
      const permissionBlockReason = autonomousActionBlockReason(permissionCommand);
      const configuredPermissionBlockReason = configuredActionBlockReason(permissionCommand, forbiddenActions);
      if (!permissionCommand || !isAutonomousPermissionResponseAllowed(permissionResponse)) {
        return { ok: false, error: '权限确认必须提供命令说明，并且响应只能是 y、yes、allow 或 approve' };
      }
      if (permissionBlockReason) {
        return { ok: false, error: `监督 AI 禁止自动确认${permissionBlockReason}；请交给人工确认` };
      }
      if (configuredPermissionBlockReason) {
        return { ok: false, error: `权限请求命中用户勾选的禁止事项：${configuredPermissionBlockReason}；请交给人工确认` };
      }
      const permissionScopeBlockReason = workScopeBlockReason(
        permissionCommand,
        session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
        lane.scopeRoot || lane.projectDir,
      );
      if (permissionScopeBlockReason) {
        return { ok: false, error: `${permissionScopeBlockReason}；该权限请求必须交给人工确认` };
      }
      if (outcome === 'complete' || outcome === 'needs-human') {
        return { ok: false, error: '终端权限确认只能与 continue 或 rework 裁决一起提交' };
      }
      if (next) {
        return { ok: false, error: '终端权限确认后需等待代理恢复；请不要在同一裁决中追加 --next' };
      }
    }
    if (!lane.awaitingReview) {
      return { ok: false, error: '当前没有待裁决轮次；请等待工作终端任务结束或权限阻塞通知' };
    }
    const agentState = ((w.__wmux_getAgentStates?.() || {})[surfaceId] || undefined) as SupervisorAgentStateView | undefined;
    const selectedPermissions = selectedAutonomyPermissions(session.autonomyPermissions);
    const requiredPermissions = requiredAutonomyPermissions({
      outcome,
      next,
      proposalKind,
      permissionCommand,
      permissionResponse,
      agentState,
    });
    const missingPermissions = requiredPermissions.filter((permission) => !selectedPermissions.includes(permission));
    if (missingPermissions.length > 0) {
      const labels = missingPermissions.map((permission) => AUTONOMY_PERMISSION_LABELS[permission]).join('、');
      return { ok: false, error: `当前会话未授予“${labels}”；请使用 needs-human 交给人工处理` };
    }
    if (permissionCommand || permissionResponse) {
      if (!isPermissionBlockedState(agentState)) {
        return { ok: false, error: '未检测到可自动确认的真实权限阻塞；状态未知或普通输入必须交给人工' };
      }
      const terminalEvidence = terminalScreenTail(surfaceId);
      if (!terminalEvidence) {
        return { ok: false, error: '无法读取当前终端中的具体权限命令；不能仅凭 Hook 泛化原因自动确认' };
      }
      if (!permissionCommandMatchesEvidence(permissionCommand, terminalEvidence)) {
        return { ok: false, error: '权限命令与当前终端提示中的具体命令不一致；不能自动确认，请交给人工' };
      }
      const permissionEvidence = [agentState.blockedReason || '', terminalEvidence].filter(Boolean).join('\n');
      const evidenceRisk = autonomousActionBlockReason(permissionEvidence);
      if (evidenceRisk) {
        return { ok: false, error: `当前权限提示包含${evidenceRisk}；不能自动确认，请交给人工` };
      }
      const configuredEvidenceRisk = configuredActionBlockReason(permissionEvidence, forbiddenActions);
      if (configuredEvidenceRisk) {
        return { ok: false, error: `当前权限提示命中禁止事项：${configuredEvidenceRisk}；不能自动确认，请交给人工` };
      }
      const evidenceScopeRisk = workScopeBlockReason(
        permissionEvidence,
        session.workScope || DEFAULT_SUPERVISOR_WORK_SCOPE,
        lane.scopeRoot || lane.projectDir,
      );
      if (evidenceScopeRisk) {
        return { ok: false, error: `${evidenceScopeRisk}；不能自动确认，请交给人工` };
      }
      if (blockedRequestAlreadyAnswered(lane, agentState)) {
        return { ok: false, error: '该权限阻塞状态已经确认过，禁止重复发送响应' };
      }
    } else if (agentState?.state === 'blocked' && outcome !== 'needs-human' && !next) {
      return { ok: false, error: '工作终端仍在阻塞；请明确回答技术问题、确认低风险权限，或使用 needs-human' };
    } else if (next && outcome !== 'needs-human') {
      if (agentState?.state === 'working') {
        return { ok: false, error: '工作终端仍在运行，不能注入下一步' };
      }
      if (isPermissionBlockedState(agentState)) {
        return { ok: false, error: '当前是权限阻塞，必须使用权限确认参数，不能发送普通下一步' };
      }
      if (agentState?.state === 'blocked' && !isQuestionBlockedState(agentState)) {
        return { ok: false, error: '当前阻塞不是明确的技术问题或方案选择，不能自动输入内容' };
      }
      if (isQuestionBlockedState(agentState) && !isLowRiskTechnicalQuestion(agentState, next)) {
        return { ok: false, error: '当前输入涉及用户偏好、业务/账户决定或缺少明确技术证据；请使用 needs-human' };
      }
      if (isQuestionBlockedState(agentState) && blockedRequestAlreadyAnswered(lane, agentState)) {
        return { ok: false, error: '该技术问题阻塞状态已经回答过，禁止重复发送响应' };
      }
    }
    if (outcome === 'complete' && agentState?.state === 'working') {
      return { ok: false, error: '工作终端仍在运行，不能判定完成' };
    }

    // The worker can emit several lifecycle updates while it is waiting. Keep
    // the first pending human decision stable so Feishu has one card to act on.
    if (outcome === 'needs-human' && session.pendingApprovals.some((approval) => approval.laneId === lane.id)) {
      store.appendSupervisorLog(lane.id, '重复人工决策已忽略', reason || '该终端已有待决项');
      return { ok: true, outcome, duplicate: true };
    }

    appendSupervisorRecord(session, lane, 'supervisor.decision', {
      outcome,
      reason,
      next,
      proposalKind,
      impact,
      alternatives,
    });
    store.appendSupervisorLog(lane.id, '监督裁决', `${outcome}${reason ? `：${reason}` : ''}`);
    const autoDecisionsUsed = nextSupervisorDecisionCount(lane.autoDecisionsUsed, permissionResponse);
    const limitReached = !session.autonomous && !permissionResponse && reachesAutoDecisionLimit(lane, session.maxAutoDecisions);
    store.updateLane(lane.id, {
      autoDecisionsUsed,
      decisions: [
        {
          ts: Date.now(),
          task: lane.currentTask || '（任务未上报）',
          outcome,
          ...(proposalKind ? { proposalKind: proposalKind as SupervisorDecision['proposalKind'] } : {}),
          reason,
          next,
        },
        ...(lane.decisions || []),
      ].slice(0, 100),
    });

    if (limitReached && outcome !== 'needs-human') {
      store.updateLane(lane.id, {
        autoDecisionLimitReached: true,
        awaitingReview: true,
        ...(outcome === 'complete' ? { awaitingStopCheck: true } : {}),
      });
      const text = `已达到 ${normalizedMaxAutoDecisions(session.maxAutoDecisions)} 次自动判断上限；请人工审阅 ${lane.label} 后再继续。`;
      const workspaceId = lane.workspaceId || store.activeWorkspaceId;
      if (workspaceId) store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
      window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      return { ok: true, outcome, requiresHuman: true };
    }

    if (outcome === 'complete') {
      store.confirmStopCondition(lane.id);
      return { ok: true, outcome };
    }

    if (permissionResponse) {
      try {
        sendToSurface(lane.surfaceId, permissionResponse, true);
      } catch (err) {
        const error = String((err as Error)?.message || err);
        store.updateLane(lane.id, {
          awaitingReview: true,
          autoDecisionsUsed: lane.autoDecisionsUsed ?? 0,
          decisions: lane.decisions || [],
        });
        appendSupervisorRecord(session, lane, 'supervisor.delivery.failed', { kind: 'permission', error });
        store.appendSupervisorLog(lane.id, '权限响应发送失败', error);
        return { ok: false, error: `权限响应发送失败：${error}` };
      }
      appendSupervisorRecord(session, lane, 'supervisor.permission-approved', {
        command: permissionCommand,
        response: permissionResponse,
      });
      store.appendSupervisorLog(lane.id, 'AI 自动授权', permissionCommand);
      store.updateLane(lane.id, {
        awaitingReview: false,
        lastBlockedResponseVersion: agentState!.blockedVersion,
        lastBlockedResponseId: agentState!.blockedRequestId || undefined,
      });
      return { ok: true, outcome, autoAuthorized: true };
    }

    if (outcome === 'needs-human') {
      store.updateLane(lane.id, { awaitingReview: true, ...(limitReached ? { autoDecisionLimitReached: true } : {}) });
      const kind = proposalKinds.has(proposalKind) ? proposalKind as 'route-change' | 'important' : 'important';
      const approval = {
        laneId: lane.id,
        surfaceId: lane.surfaceId,
        laneLabel: lane.label,
        text: next,
        source: kind === 'route-change' ? 'supervisor-route' as const : 'supervisor-important' as const,
        proposalKind: kind,
        reason: reason || `${lane.label} 需要人工决策`,
        impact,
        alternatives,
        task: lane.currentTask || '（任务未上报）',
      };
      store.enqueueApproval(approval);
      const pending = useStore.getState().supervisor.pendingApprovals[0];
      if (pending) {
        appendSupervisorRecord(useStore.getState().supervisor, lane, 'supervisor.approval.requested', {
          approvalId: pending.id,
          reason: approval.reason,
          impact: approval.impact,
          alternatives: approval.alternatives,
          proposalKind: approval.proposalKind,
        });
      }
      const text = `${kind === 'route-change' ? '路线变更' : '重要建议'}待你决定：${reason || lane.label}`;
      const workspaceId = lane.workspaceId || store.activeWorkspaceId;
      if (workspaceId) {
        store.addNotification({ surfaceId: lane.surfaceId, workspaceId, text });
      }
      window.wmux?.notification?.fire({ surfaceId: lane.surfaceId, title: 'AI 监督', text });
      return { ok: true, outcome };
    }

    if (next) {
      try {
        sendToSurface(lane.surfaceId, next, session.submitEnter);
      } catch (err) {
        const error = String((err as Error)?.message || err);
        store.updateLane(lane.id, {
          awaitingReview: true,
          autoDecisionsUsed: lane.autoDecisionsUsed ?? 0,
          decisions: lane.decisions || [],
        });
        appendSupervisorRecord(session, lane, 'supervisor.delivery.failed', { kind: 'next', error });
        store.appendSupervisorLog(lane.id, '下一步发送失败', error);
        return { ok: false, error: `下一步发送失败：${error}` };
      }
    }
    store.updateLane(lane.id, {
      awaitingReview: false,
      ...(isQuestionBlockedState(agentState) ? {
        lastBlockedResponseVersion: agentState.blockedVersion,
        lastBlockedResponseId: agentState.blockedRequestId || undefined,
      } : {}),
    });
    return { ok: true, outcome };
  };

  // The Feishu main-process gateway authenticates the caller; this renderer
  // bridge only accepts its small, explicit set of supervision/task actions.
  w.__wmux_supervisorRemoteControl = (params: any) => {
    const action = String(params?.action || '');
    if (action === 'list') {
      const state = useStore.getState().supervisor;
      return {
        ok: true,
        message: JSON.stringify({
          active: state.active,
          terminals: remoteTerminalList().map((terminal) => ({
            surfaceId: terminal.surfaceId,
            label: terminal.label,
            workspace: terminal.workspaceTitle,
            supervised: state.lanes.some((lane) => lane.surfaceId === terminal.surfaceId && lane.enabled),
          })),
          session: state.active ? { sessionId: state.sessionId, stopWhen: state.stopWhen, autonomous: state.autonomous } : null,
          pendingApprovals: state.pendingApprovals.map((approval) => ({ id: approval.id, terminal: approval.laneLabel, reason: approval.reason || '' })),
        }),
      };
    }
    if (action === 'start') return startRemoteSupervisor(params as RemoteSupervisorStart);
    if (action === 'send') return sendRemoteTerminalTask(params as RemoteTerminalTask);
    if (action === 'stop') {
      const session = useStore.getState().supervisor;
      if (!session.active) return { ok: false, error: '当前没有进行中的 AI 监督。', message: '' };
      useStore.getState().stopSupervisor('由飞书远程停止');
      for (const lane of session.lanes) remoteAudit(session, lane, 'supervisor.remote-command', { action: 'stop', actor: String(params?.actor || 'unknown') });
      return { ok: true, message: '已停止当前 AI 监督。' };
    }
    if (action === 'decide') {
      const decision = String(params?.decision || '');
      if (!['approve', 'reject', 'stop'].includes(decision)) return { ok: false, error: '无效的人工决策。', message: '' };
      return decideRemoteSupervisor(String(params?.approvalId || ''), decision as 'approve' | 'reject' | 'stop', String(params?.task || ''), String(params?.actor || 'unknown'));
    }
    return { ok: false, error: '不支持的监督控制动作。', message: '' };
  };

  // ─── Markdown ───────────────────────────────────────────────────────────────

  w.__wmux_setMarkdownContent = (surfaceId: string, markdown: string, fileName?: string, filePath?: string, mtimeMs?: number) => {
    // Persist into the store so MarkdownPane (re)renders the content. The old
    // `wmux:markdown-update` CustomEvent had no listener, so content never
    // displayed (issue #54). `fileName`, when the content came from a file, is
    // used as the tab label so multiple markdown tabs stay distinguishable;
    // `filePath` makes the surface path-aware (issue #116) so the pane can show
    // the path, copy it, reveal it, and reload from it.
    // `mtimeMs` (F3) records what was on disk at load time so a later save can
    // detect an agent having rewritten the file underneath the pane.
    useStore.getState().setMarkdownContent(surfaceId as SurfaceId, markdown ?? '', { fileName, filePath, mtimeMs });
    return { ok: true };
  };

  // Read a markdown surface's buffer back out (issue #116). Mirrors
  // __wmux_readScreen for terminals — an agent that pushed content has no other
  // way to check what actually landed.
  w.__wmux_getMarkdownContent = (surfaceId: string) => {
    const state = useStore.getState();
    for (const ws of state.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const surface = findLeaf(ws.splitTree, paneId)?.surfaces.find((s) => s.id === surfaceId);
        if (surface) {
          return {
            surfaceId,
            content: surface.markdownContent ?? '',
            filePath: surface.markdownFilePath ?? null,
            fileName: surface.markdownFileName ?? null,
            dirty: !!surface.markdownDirty,
          };
        }
      }
    }
    return null;
  };

  // ─── Notifications ──────────────────────────────────────────────────────────

  w.__wmux_listNotifications = () => {
    return useStore.getState().notifications || [];
  };

  w.__wmux_clearNotification = (id: string) => {
    useStore.getState().clearNotification(id);
  };

  w.__wmux_clearAllNotifications = () => {
    useStore.getState().clearAll();
  };

  // ─── Tree ───────────────────────────────────────────────────────────────────

  w.__wmux_getTree = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    return ws?.splitTree || null;
  };
}
