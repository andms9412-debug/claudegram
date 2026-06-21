import { config } from '../config.js';

export interface ParsedCommand {
  command: string | null;
  args: string;
  model: string | null;
}

const CLAUDE_COMMANDS = ['plan', 'explore', 'model', 'commands', 'loop', 'resume', 'continue', 'sessions', 'provider'] as const;
type ClaudeCommand = (typeof CLAUDE_COMMANDS)[number];

export function parseClaudeCommand(message: string): ParsedCommand {
  const trimmed = message.trim();

  // Check if message starts with a slash command
  if (!trimmed.startsWith('/')) {
    return { command: null, args: trimmed, model: null };
  }

  const firstSpace = trimmed.indexOf(' ');
  const commandPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  // Check if it's a Claude command
  if (CLAUDE_COMMANDS.includes(commandPart as ClaudeCommand)) {
    return { command: commandPart, args, model: null };
  }

  // Not a recognized Claude command - return as regular message
  return { command: null, args: trimmed, model: null };
}

export function isClaudeCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return false;

  const firstSpace = trimmed.indexOf(' ');
  const commandPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);

  return CLAUDE_COMMANDS.includes(commandPart as ClaudeCommand);
}

// Returns MarkdownV2 escaped command list
export function getAvailableCommands(): string {
  const sections: Array<{ title: string; commands: string[] }> = [
    {
      title: 'Claude 指令',
      commands: [
        '• `/plan <task>` \\- 進入規劃模式，處理複雜任務',
        '• `/explore <question>` \\- 用探索代理搜尋程式碼庫',
        '• `/loop <task>` \\- 反覆執行直到任務完成',
        '• `/model \\[name\\]` \\- 顯示或切換 AI 模型',
        ...(config.OPENCODE_ENABLED ? ['• `/provider` \\- 切換 AI 供應商（Claude / OpenCode）'] : []),
        '• `/commands` \\- 顯示指令列表',
      ],
    },
    {
      title: '會話指令',
      commands: [
        '• `/project <path>` \\- 設定工作目錄',
        '• `/newproject <name>` \\- 建立新專案',
        '• `/resume` \\- 從近期會話中選擇恢復',
        '• `/continue` \\- 恢復最近一次會話',
        '• `/sessions` \\- 列出所有會話',
        '• `/teleport` \\- 將會話移到終端機（fork）',
        '• `/clear` \\- 清除會話重新開始',
        '• `/status` \\- 顯示目前會話資訊',
      ],
    },
    {
      title: '檔案指令',
      commands: [
        '• `/file <path>` \\- 下載專案中的檔案',
        '• `/telegraph <path>` \\- 用 Instant View 檢視 Markdown',
      ],
    },
  ];

  const redditCommands: string[] = [];
  if (config.REDDIT_ENABLED) {
    redditCommands.push('• `/reddit <target>` \\- 抓取 Reddit 貼文、子版或使用者資料');
  }
  if (config.VREDDIT_ENABLED) {
    redditCommands.push('• `/vreddit <url>` \\- 下載 Reddit 影片');
  }
  if (redditCommands.length > 0) {
    sections.push({ title: 'Reddit 指令', commands: redditCommands });
  }

  if (config.MEDIUM_ENABLED) {
    sections.push({
      title: 'Medium 指令',
      commands: ['• `/medium <url>` \\- 抓取 Medium 文章（含圖片）'],
    });
  }

  const mediaCommands: string[] = [];
  if (config.EXTRACT_ENABLED) {
    mediaCommands.push('• `/extract <url>` \\- 從 YouTube、Instagram、TikTok 擷取內容');
  }
  if (config.TRANSCRIBE_ENABLED) {
    mediaCommands.push('• `/transcribe` \\- 語音轉文字（回覆語音訊息，或 ForceReply）');
  }
  if (mediaCommands.length > 0) {
    sections.push({ title: '媒體指令', commands: mediaCommands });
  }

  sections.push({
    title: '機器人指令',
    commands: [
      '• `/tts` \\- 開關語音回覆',
      '• `/context` \\- 顯示 Claude 上下文用量',
      '• `/botstatus` \\- 顯示機器人狀態',
      '• `/restartbot` \\- 重啟機器人',
      '• `/ping` \\- 檢查機器人是否在線',
      '• `/cancel` \\- 取消目前的請求',
      '• `/mode` \\- 切換串流模式',
      '• `/terminalui` \\- 切換終端機顯示風格',
    ],
  });

  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`*${section.title}:*`, '', ...section.commands, '');
  }

  return lines.join('\n').trimEnd();
}
