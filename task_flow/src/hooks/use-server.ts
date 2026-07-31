import { useEffect, useRef } from 'react'
import { useSetting } from '@/hooks/use-settings'
import { isRemoteMode } from '@/lib/connection'

const RESTART_DELAY = 3000
const HEALTH_CHECK_INTERVAL = 10_000
const MAX_SPAWN_FAILURES = 5
const SERVICE_ID = 'taskflow-mcp'

/** Probe /healthz to see if a TaskFlow server is already running on this port */
async function probeServer(port: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`http://localhost:${port}/healthz`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
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

  useEffect(() => {
    mountedRef.current = true

    // Skip sidecar spawn in remote mode — no local server needed
    if (isRemoteMode()) return

    const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window
    if (!isTauri) return

    let killed = false
    let healthTimer: ReturnType<typeof setInterval> | null = null
    let consecutiveFailures = 0

    async function doSpawn() {
      if (killed || !mountedRef.current) return

      try {
        const { Command } = await import('@tauri-apps/plugin-shell')

        console.log('[useServer] spawning: taskflow-mcp --http-only --port', port)

        const command = Command.create('taskflow-server', ['--http-only', '--port', String(port)])

        command.on('close', (data) => {
          console.log(`[useServer] server exited code=${data.code}`)
          childRef.current = null

          if (data.code !== 0) {
            consecutiveFailures++
            if (consecutiveFailures >= MAX_SPAWN_FAILURES) {
              console.error(`[useServer] ${MAX_SPAWN_FAILURES} consecutive failures — giving up`)
              return
            }
          } else {
            consecutiveFailures = 0
          }

          if (!killed && mountedRef.current) {
            setTimeout(spawnIfNeeded, RESTART_DELAY)
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
        consecutiveFailures++
        if (consecutiveFailures >= MAX_SPAWN_FAILURES) {
          console.error(`[useServer] ${MAX_SPAWN_FAILURES} consecutive failures — giving up`)
          return
        }
        if (!killed && mountedRef.current) {
          setTimeout(spawnIfNeeded, RESTART_DELAY)
        }
      }
    }

    async function spawnIfNeeded() {
      if (killed || !mountedRef.current) return

      // Always check first — prevents duplicate spawns (React strict mode, HMR, etc.)
      const alreadyRunning = await probeServer(port)
      if (alreadyRunning) {
        console.log('[useServer] server already running on port', port, '— skipping spawn')
        startHealthCheck()
        return
      }

      doSpawn()
    }

    /** Periodically verify the external server is still alive; spawn if it dies */
    function startHealthCheck() {
      stopHealthCheck()
      healthTimer = setInterval(async () => {
        if (killed || !mountedRef.current) { stopHealthCheck(); return }
        if (childRef.current) return
        const alive = await probeServer(port)
        if (!alive) {
          console.log('[useServer] external server gone — spawning')
          stopHealthCheck()
          doSpawn()
        }
      }, HEALTH_CHECK_INTERVAL)
    }

    function stopHealthCheck() {
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
    }

    // Always probe first — if server already exists (e.g. from previous mount), reuse it
    spawnIfNeeded()

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
