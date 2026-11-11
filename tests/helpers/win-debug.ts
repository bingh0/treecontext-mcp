import { spawnSync } from 'node:child_process'

/**
 * Temporary (2026-11-11), for the Windows lane's last failures: the
 * processes alive at a moment, printed to stderr, when TC_WIN_DEBUG is set
 * on Windows. A test home that cannot be removed or renamed is held by a
 * process, and only the runner can say which. Remove with the debug step
 * in ci.yml once the lane is read.
 */
export function winSnapshot(label: string): void {
  if (process.platform !== 'win32' || !process.env['TC_WIN_DEBUG']) return
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|cmd|codex|agy|bash|sh\\.exe|git|conhost|taskkill|MsMpEng|SearchIndexer' } | ForEach-Object { '{0} ppid={1} {2} :: {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine }"
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60_000 })
  const lines = (r.stdout ?? '').split(/\r?\n/).filter(l => l.trim() !== '').map(l => l.slice(0, 420))
  console.error(`[win-debug] ${label}: this pid ${process.pid}; ${lines.length} processes\n${lines.map(l => `[win-debug]   ${l}`).join('\n')}`)
}
