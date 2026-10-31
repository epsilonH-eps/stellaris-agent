/**
 * 游戏界面辅助：镜头跟随 + 关闭 AI 打开的游戏窗口。
 *
 * 镜头只影响界面，不改变游戏状态；关闭窗口用 ESC（WM_KEYDOWN/UP），
 * 在 AI 执行 open_alert/open_notification/show_panel 之后延迟执行。
 *
 * @module stellaris-agent/ui
 */
import { execFile } from 'node:child_process'

const IDLE = /无指令|空闲|待命|idle/i

function fleetText(fleet) {
  return `${fleet?.status || ''} ${fleet?.order || ''} ${fleet?.mission || ''}`.trim()
}

function fleetScore(fleet) {
  const text = fleetText(fleet)
  let score = 0
  if (/战斗|交火|combat|battle|firing/i.test(text)) score += 100
  else if (/调查|勘测|研究|survey|research/i.test(text)) score += 60
  else if (/前往|移动|航行|move|travel|coloniz|建造|construct|升级|upgrade/i.test(text)) score += 50
  else if (text && !IDLE.test(text)) score += 30
  if (fleet?.order) score += 20
  if (String(fleet?.kind || '') === 'military') score += 5
  return score
}

function colonyScore(colony) {
  let score = Number(colony?.population ?? 0) || 0
  const details = colony?.details || {}
  if (details.buildQueue?.length || details.build_queue?.length) score += 25
  if (details.districts || details.buildings) score += 10
  return score
}

/**
 * 选出当前最活跃的船（有订单/移动/调查/战斗）或星球（有建造队列，否则人口最多）。
 * @returns {{type:'fleet'|'planet', id:number, score:number, reason:string}|null}
 */
export function selectFollowTarget(world) {
  const fleets = (world?.fleetsAll || [])
    .filter((fleet) => Number.isFinite(Number(fleet.fleet_id)))
    .map((fleet) => ({ fleet, score: fleetScore(fleet) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.fleet.fleet_id) - Number(b.fleet.fleet_id))
  if (fleets.length) {
    const best = fleets[0]
    return {
      type: 'fleet',
      id: Number(best.fleet.fleet_id),
      score: best.score,
      reason: String(best.fleet.status || best.fleet.order || '执行任务'),
    }
  }

  const colonies = (world?.colonies || [])
    .filter((colony) => Number.isFinite(Number(colony.planet_id)))
    .map((colony) => ({ colony, score: colonyScore(colony) }))
    .sort((a, b) => b.score - a.score || Number(a.colony.planet_id) - Number(b.colony.planet_id))
  if (colonies.length) {
    const best = colonies[0]
    return {
      type: 'planet',
      id: Number(best.colony.planet_id),
      score: best.score,
      reason: best.colony.name || '人口最多的殖民地',
    }
  }
  return null
}

/**
 * 向 Stellaris 主窗口发 ESC，关闭 AI 打开的界面。
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string}>}
 */
export function closeGameWindow({ processName = 'stellaris', timeoutMs = 10000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, skipped: true })
  const safeName = String(processName).replace(/[^a-zA-Z0-9_.-]/g, '')
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-Process -Name '${safeName}' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { exit 0 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class StellarisUiNative {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
[StellarisUiNative]::PostMessage($p.MainWindowHandle, 0x0100, [IntPtr]0x1B, [IntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 120
[StellarisUiNative]::PostMessage($p.MainWindowHandle, 0x0101, [IntPtr]0x1B, [IntPtr]::Zero) | Out-Null
`
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs },
      (error) => {
        if (error) resolve({ ok: false, error: String(error.message || error) })
        else resolve({ ok: true })
      },
    )
  })
}
