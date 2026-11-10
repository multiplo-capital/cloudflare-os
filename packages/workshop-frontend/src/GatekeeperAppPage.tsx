import { useCallback, useEffect, useRef, useState } from 'react'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import SandboxedGatekeeperApp from './SandboxedGatekeeperApp'
import { reportIssue } from './errorReporting'

// The frame's `ui` is an RPC stub at runtime; dispose it to release the server-side capability.
function disposeFrame(frame: GatekeeperUiFrame | null) {
  (frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
}

// The sandboxed app asks for a refresh when its capability stops answering, and may ask in a loop
// while the gatekeeper is down, so fetches are spaced out and shared.
const MIN_REFRESH_INTERVAL_MS = 2_000

/**
 * Renders a gatekeeper's full-page management app (a sandboxed SPA the gatekeeper serves).
 * Fetches the app frame (iframe HTML + `ui` capability) from the backend and hosts it.
 */
export default function GatekeeperAppPage({ appId, path, onNavigate }: {
  appId: string
  path: string
  onNavigate: (path: string, replace: boolean) => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  // Wrap the frame in an object: it holds a `ui` RPC stub, and we never want useState's setter to
  // treat a stored value as an updater function.
  const [state, setState] = useState<{ frame: GatekeeperUiFrame } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    let cancelled = false
    let current: GatekeeperUiFrame | null = null
    let pending: Promise<void> | null = null
    let lastRefresh = 0
    // Returns whether a frame was installed. A refresh keeps the frame it has when the fetch fails.
    const install = async (): Promise<boolean> => {
      const frame = await authenticatedApi.getGatekeeperApp(appId)
      if (!frame) return false
      if (cancelled) {
        disposeFrame(frame)
        return true
      }
      const previous = current
      current = frame
      setState({ frame })
      disposeFrame(previous)
      return true
    }
    install()
      .then((installed) => {
        if (!installed && !cancelled) setError('This app is not available on this deployment.')
      })
      .catch((err) => {
        console.error('Failed to load gatekeeper app:', err)
        reportIssue('gatekeeper-app.load', err, {
          gatekeeperVendorId: appId,
        })
        // A frame already on screen stays: its app asks for a refresh until one succeeds.
        if (!cancelled && !current) setError(`${err}`)
      })
    refreshRef.current = () => {
      if (pending) return pending
      const wait = Math.max(0, lastRefresh + MIN_REFRESH_INTERVAL_MS - Date.now())
      const refresh = new Promise<void>((resolve) => setTimeout(resolve, wait))
        .then(() => {
          lastRefresh = Date.now()
          return install()
        })
        .then((installed) => {
          if (!installed) throw new Error('This app is not available on this deployment.')
        })
        .finally(() => {
          if (pending === refresh) pending = null
        })
      pending = refresh
      return refresh
    }
    return () => {
      cancelled = true
      refreshRef.current = null
      disposeFrame(current)
    }
  }, [authenticatedApi, appId])

  const onRefresh = useCallback(
    () => refreshRef.current?.() ?? Promise.reject(new Error('This app is no longer open.')),
    [],
  )

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-sm text-kumo-subtle">{error}</div>
    )
  }
  if (!state) {
    return <div className="px-4 py-16 text-center text-sm text-kumo-subtle">Loading…</div>
  }

  // Fill the routed area below the header so the embedded app can manage its own internal layout.
  return (
    <div className="h-full">
      <SandboxedGatekeeperApp frame={state.frame} gatekeeperVendorId={appId} path={path} onNavigate={onNavigate} onRefresh={onRefresh} />
    </div>
  )
}
