import { useSyncExternalStore } from 'react';
import { CloudOff, LogIn } from 'lucide-react';
import { desktop } from '../desktop/bridge';
import { getConnection, subscribeConnection } from '../desktop/serverBridge';

/** Connected to the NoteTOO server: says when the PC can't be reached or the browser was signed out. */
export function ConnectionBanner() {
  const state = useSyncExternalStore(subscribeConnection, getConnection);
  if (desktop?.mode !== 'server' || state === 'online') return null;
  return (
    <div className="connection-banner" role="status">
      {state === 'offline' ? (
        <>
          <CloudOff size={16} aria-hidden /> Can't reach NoteTOO on your PC. Reconnecting… Unsaved changes are kept in this tab.
        </>
      ) : (
        <>
          <LogIn size={16} aria-hidden /> Signed out.{' '}
          <a href="/login" target="_blank" rel="noopener">
            Sign in again
          </a>{' '}
          (in a new tab, so unsaved changes here are kept), then retry.
        </>
      )}
    </div>
  );
}
