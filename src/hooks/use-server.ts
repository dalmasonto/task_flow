import { useEffect, useRef } from 'react'
import { useSetting } from '@/hooks/use-settings'
import { setServerPort } from '@/lib/sync-api'

const RESTART_DELAY = 2000
const HEALTH_CHECK_INTERVAL = 10_000
const SERVICE_ID = 'taskflow-mcp'
// Uses the globally installed npm package
const SERVER_COMMAND = 'taskflow-mcp'

/** Probe /healthz to see if a TaskFlow server is already running on this port */
async function probeServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const body = await res.json() as { service?: string }
    return body.service === SERVICE_ID
  } catch {
    return false
  }
}

export function useServer() {
  const childRef = useRef<unknown>(null)
  const mountedRef = useRef(true)
  const port = useSetting('serverPort')

  // Keep sync-api in sync with the current port setting
  useEffect(() => {
    setServerPort(port)
  }, [port])

  useEffect(() => {
    mountedRef.current = true

    const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window
    if (!isTauri) return

    let killed = false
    let healthTimer: ReturnType<typeof setInterval> | null = null

    async function spawn() {
      if (killed || !mountedRef.current) return

      // Check if a TaskFlow server is already running on this port
      const alreadyRunning = await probeServer(port)
      if (alreadyRunning) {
        console.log('[useServer] server already running on port', port, '— skipping spawn')
        startHealthCheck()
        return
      }

      try {
        const { Command } = await import('@tauri-apps/plugin-shell')

        console.log('[useServer] spawning:', SERVER_COMMAND, '--http-only --port', port)

        const command = Command.create('taskflow-server', ['--http-only', '--port', String(port)])

        command.on('close', (data) => {
          console.log(`[useServer] server exited code=${data.code}`)
          childRef.current = null
          if (!killed && mountedRef.current) {
            setTimeout(spawn, RESTART_DELAY)
          }
        })

        command.on('error', (err) => {
          console.error('[useServer] error:', err)
        })

        command.stdout.on('data', (line) => {
          console.log('[useServer:out]', line)
        })

        command.stderr.on('data', (line) => {
          console.warn('[useServer:err]', line)
        })

        const child = await command.spawn()
        childRef.current = child
        console.log('[useServer] spawned pid:', child.pid)
      } catch (err) {
        console.error('[useServer] spawn failed:', err)
        if (!killed && mountedRef.current) {
          setTimeout(spawn, RESTART_DELAY)
        }
      }
    }

    /** Periodically verify the external server is still alive; spawn if it dies */
    function startHealthCheck() {
      stopHealthCheck()
      healthTimer = setInterval(async () => {
        if (killed || !mountedRef.current) { stopHealthCheck(); return }
        // Only check if we didn't spawn — if we spawned, the close handler handles restarts
        if (childRef.current) return
        const alive = await probeServer(port)
        if (!alive) {
          console.log('[useServer] external server gone — spawning')
          stopHealthCheck()
          spawn()
        }
      }, HEALTH_CHECK_INTERVAL)
    }

    function stopHealthCheck() {
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
    }

    spawn()

    return () => {
      killed = true
      mountedRef.current = false
      stopHealthCheck()
      if (childRef.current) {
        (childRef.current as { kill: () => void }).kill()
        childRef.current = null
      }
    }
  }, [port])
}
