/**
 * 自动发现 DSH 的 Web 端口。
 *
 * 不依赖固定 49939：先找 DSH 进程正在监听的端口，再逐个探测
 * /api/stellaris-orchestrator/health，返回 service 为 dsh-stellaris-bridge 的那个。
 *
 * @module stellaris-agent/dsh-discovery
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const POWERSHELL = process.env.SYSTEMROOT
  ? `${process.env.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe'

async function candidatePorts() {
  const script = `
$pids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'deepseek|dsh' } | Select-Object -ExpandProperty Id)
$ports = @()
if ($pids.Count -gt 0 -and (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
  $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique)
}
$ports | ConvertTo-Json -Compress
`.trim()
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-Command', script], { windowsHide: true })
    const text = String(stdout || '').trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
  } catch {
    return []
  }
}

export async function discoverDshUrl({ timeoutMs = 1500 } = {}) {
  const ports = new Set(await candidatePorts())
  for (const fallback of [49939, 49943, 49940, 8787, 8788]) ports.add(fallback)
  const tried = []
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`
    tried.push(port)
    try {
      const response = await fetch(url + '/api/stellaris-orchestrator/health', {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) continue
      const body = await response.json().catch(() => ({}))
      if (body?.ok && /dsh-stellaris-bridge|stellaris-orchestrator/.test(String(body.service || ''))) {
        return { ok: true, url, port, service: body.service || null, tried }
      }
    } catch {
      /* 继续试下一个端口 */
    }
  }
  return { ok: false, error: 'DSH_NOT_FOUND', tried }
}
