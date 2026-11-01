type ShellApproval = {
  description?: string;
  reason?: 'policy' | 'destructive' | 'external';
  systemWrite?: boolean;
  command: string;
};

export function shellApprovalText(args: ShellApproval): string {
  const purpose = args.description?.trim() || '我需要运行一个程序才能继续，可以吗？';
  const request = /[？?]$/.test(purpose) ? purpose : `${purpose.replace(/[。！!]+$/, '')}，可以吗？`;
  const warning = args.reason === 'destructive' ? '这一步可能删除或覆盖数据。'
    : args.reason === 'external' ? '这一步可能删除数据，或向外部发送、发布内容。' : '';
  return [request, warning,
    args.systemWrite ? `请注意：这条命令会获得整个 /system 目录的写入权限，不只限于某个文件。\n将执行的完整命令：\n${args.command}` : '',
  ].filter(Boolean).join('\n');
}

/** Only rewrite known historical templates; keep custom requests and risk details intact. */
export function readableApprovalText(content: string): string {
  if (content.startsWith('请求执行命令')) return shellApprovalText({ command: '' });
  const legacy = /^需要你的确认：([^\n]+)\n(命令中检测到删除、覆盖或其他破坏性操作，需要单独确认。|Bot 将此操作标记为会删除数据或对外产生影响，需要单独确认。|当前 Bot 的命令权限设为“每次询问”。|当前工作区的命令权限设为“每次询问”，会优先于全局的允许设置。)\n仅批准这一次操作。/.exec(content);
  if (!legacy) return content;
  const reason = legacy[2].startsWith('命令中') ? 'destructive' : legacy[2].startsWith('Bot 将') ? 'external' : 'policy';
  // Preserve any additional warning and the complete system-write command verbatim.
  return shellApprovalText({ description: legacy[1], reason, command: '' }) + content.slice(legacy[0].length);
}
