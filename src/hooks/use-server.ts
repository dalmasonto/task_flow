import { useEffect, useRef } from 'react'

const SERVER_SCRIPT = 'mcp-server/dist/index.js'
const RESTART_DELAY = 2000

export function useServer() {
  const childRef = useRef<unknown>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    // Only spawn in Tauri — in browser, the user or Claude Code manages the server
    if (!('__TAURI__' in window)) return

    let killed = false

    async function spawn() {
      try {
        const { Command } = await import('@tauri-apps/plugin-shell')

        const command = Command.create('node', [SERVER_SCRIPT, '--http-only'])

        command.on('close', (data) => {
          console.log(`[useServer] server exited with code ${data.code}`)
          childRef.current = null
          // Auto-restart unless we intentionally killed it
          if (!killed && mountedRef.current) {
            console.log(`[useServer] restarting in ${RESTART_DELAY}ms...`)
            setTimeout(spawn, RESTART_DELAY)
          }
        })

        command.on('error', (err) => {
          console.error('[useServer] spawn error:', err)
        })

        command.stdout.on('data', (line) => {
          console.log('[useServer:stdout]', line)
        })

        command.stderr.on('data', (line) => {
          console.warn('[useServer:stderr]', line)
        })

        const child = await command.spawn()
        childRef.current = child
        console.log('[useServer] HTTP server started (pid:', child.pid, ')')
      } catch (err) {
        console.error('[useServer] failed to spawn server:', err)
        // Retry after delay
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
        console.log('[useServer] killing server process')
        ;(childRef.current as { kill: () => void }).kill()
        childRef.current = null
      }
    }
  }, [])
}
