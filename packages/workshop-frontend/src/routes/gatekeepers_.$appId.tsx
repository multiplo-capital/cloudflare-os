import { useCallback } from 'react'
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

/**
 * Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
 * apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
 * gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
 *
 * The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
 * nesting inside the /gatekeepers connectors page's component. Paths below it
 * (`gatekeepers_.$appId.$`) render here too, so moving between them keeps the app's iframe mounted.
 */
export const Route = createFileRoute('/gatekeepers_/$appId')({
  component: GatekeeperApp,
})

function GatekeeperApp() {
  const { appId } = Route.useParams()
  const { _splat: splat } = useParams({ strict: false })
  const navigate = useNavigate()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  const onNavigate = useCallback((path: string, replace: boolean) => {
    void navigate({ to: '/gatekeepers/$appId/$', params: { appId, _splat: path.slice(1) }, replace })
  }, [appId, navigate])
  return <GatekeeperAppPage appId={appId} path={`/${splat ?? ''}`} onNavigate={onNavigate} />
}
