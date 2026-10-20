import { useEffect, useState } from 'react';
import { useDaemon } from './daemon';

const useNow = (ms: number) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};

export function App() {
  const daemon = useDaemon();
  const now = useNow(1000);

  return (
    <div className="app">
      <div className="main">mai</div>
      <div className="status" data-testid="daemon-status">
        <span>
          <span className="dot" data-state={daemon.status}>
            ●
          </span>{' '}
          daemon {daemon.status}
        </span>
        {daemon.status === 'connected' && (
          <>
            <span>v{daemon.version}</span>
            <span>up {Math.round((now - daemon.startedAt) / 1000)}s</span>
            {daemon.rtt !== undefined && <span>rtt {daemon.rtt} ms</span>}
          </>
        )}
      </div>
    </div>
  );
}
