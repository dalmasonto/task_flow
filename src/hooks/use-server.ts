import { useEffect, useRef } from 'react'

const RESTART_DELAY = 2000
const SERVER_SCRIPT = '/home/dalmas/E/projects/local_task_tracker/task_flow/mcp-server/dist/index.js'

export function useServer() {
  const childRef = useRef<unknown>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window
    if (!isTauri) return

    let killed = false

    async function spawn() {
      if (killed || !mountedRef.current) return

      try {
        const { Command } = await import('@tauri-apps/plugin-shell')

        console.log('[useServer] spawning: node', SERVER_SCRIPT, '--http-only')

        const command = Command.create('taskflow-server', [SERVER_SCRIPT, '--http-only'])

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

    spawn()

    return () => {
      killed = true
      mountedRef.current = false
      if (childRef.current) {
        (childRef.current as { kill: () => void }).kill()
        childRef.current = null
      }
    }
  }, [])
}
