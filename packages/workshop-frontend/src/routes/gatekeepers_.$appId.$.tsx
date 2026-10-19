import { createFileRoute } from '@tanstack/react-router'

/**
 * A path inside a gatekeeper app, e.g. /gatekeepers/review/runs. The parent route keeps the app's
 * iframe mounted and hands it the path; this route only makes the sub-path resolvable.
 */
export const Route = createFileRoute('/gatekeepers_/$appId/$')({
  component: () => null,
})
