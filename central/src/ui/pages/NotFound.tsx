import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Compass, TriangleAlert, LayoutDashboard, RotateCw } from 'lucide-react';
import { Button, ButtonLink, EmptyState } from '../components/ui';
import { errorMessage } from '../lib/query';

export function NotFound() {
  return (
    <EmptyState icon={Compass} title="This page doesn’t exist" className="py-24" action={<ButtonLink to="/" icon={LayoutDashboard} variant="primary">Go to Overview</ButtonLink>}>
      The link may be old, or the site or device may have been deleted.
    </EmptyState>
  );
}

export function RouteError() {
  const err = useRouteError();
  const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : errorMessage(err);
  const chunk = /dynamically imported module|Importing a module script failed/i.test(msg);
  return (
    <EmptyState
      icon={TriangleAlert}
      title={chunk ? 'Screens was updated' : 'This page hit a problem'}
      className="py-24"
      action={
        <>
          <Button variant="primary" icon={RotateCw} onClick={() => location.reload()}>Reload</Button>
          <ButtonLink to="/" icon={LayoutDashboard}>Overview</ButtonLink>
        </>
      }
    >
      {chunk ? 'A newer version is available. Reload to continue.' : <span className="font-mono text-xs [overflow-wrap:anywhere]">{msg}</span>}
    </EmptyState>
  );
}
