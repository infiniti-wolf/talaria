// A one-time notice for people who set Talaria up with Hermes Agent: Talaria no longer needs it,
// and one click removes it. Closing the notice before choosing counts as "keep it"; it never comes back.
// Removing runs in the background, so the notice can be closed meanwhile: a notification follows
// along and says when it's done.

import * as React from 'react';
import { toast } from 'sonner';
import { Check, HardDrive, Loader, Trash2, TriangleAlert } from 'lucide-react';
import type { HermesCleanupState } from '@shared/types';
import { api } from '@/lib/api';
import { useApp } from '@/lib/store';
import { Button, Dialog } from '@/components/ui';

type Offer = { show: boolean; home?: string; sizeBytes?: number } & Partial<HermesCleanupState>;
type Result = NonNullable<HermesCleanupState['result']>;

const TOAST_ID = 'hermes-cleanup';
const size = (bytes = 0) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

function showProgressToast(stage?: string) {
  toast.loading('Removing Hermes Agent', {
    id: TOAST_ID,
    description: `${stage ? `${stage}. ` : ''}You'll get a notification here when it's done.`,
    duration: Infinity,
  });
}

function showResultToast(r: Result) {
  if (r.ok) toast.success('Hermes Agent is removed', { id: TOAST_ID, description: `${size(r.freedBytes)} freed. Talaria keeps working exactly as before.`, duration: 15000 });
  else toast.error('Hermes Agent is almost removed', { id: TOAST_ID, description: r.message + (r.freedBytes > 0 ? ` ${size(r.freedBytes)} freed so far.` : ''), duration: Infinity });
}

export function HermesCleanup() {
  const [offer, setOffer] = React.useState<Offer | null>(null);
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<Result | null>(null);
  const live = useApp(s => s.hermesCleanup);
  const removing = !!live?.removing;
  const openRef = React.useRef(open);
  openRef.current = open;

  React.useEffect(() => {
    api
      .get<Offer>('/api/hermes-cleanup', { quiet: true })
      .then(o => {
        setOffer(o);
        // Already removing (the page was reloaded meanwhile): just follow along in the notification.
        if (o.removing) {
          useApp.setState({ hermesCleanup: { removing: true, stage: o.stage } });
          showProgressToast(o.stage);
        } else setOpen(o.show);
      })
      .catch(() => {});
  }, []);

  // Progress and the outcome arrive as server events.
  React.useEffect(() => {
    if (!live) return;
    if (live.removing) {
      if (!openRef.current) showProgressToast(live.stage);
    } else if (live.result) {
      setResult(live.result);
      if (openRef.current) toast.dismiss(TOAST_ID);
      else showResultToast(live.result);
    }
  }, [live]);

  const close = () => {
    setOpen(false);
    if (removing) showProgressToast(live?.stage);
    else if (!result) api.post('/api/hermes-cleanup/dismiss', {}, { quiet: true }).catch(() => {});
  };

  const remove = async () => {
    useApp.setState({ hermesCleanup: { removing: true, stage: 'Getting ready' } });
    try {
      await api.post('/api/hermes-cleanup/remove', {}, { quiet: true });
    } catch (err: any) {
      useApp.setState({ hermesCleanup: { removing: false, result: { ok: false, freedBytes: 0, message: err?.message || 'Something went wrong.' } } });
    }
  };

  if (!offer?.show) return null;

  return (
    <Dialog open={open} onOpenChange={v => (v ? setOpen(true) : close())} title={result ? (result.ok ? 'Hermes Agent is removed' : 'Almost done') : 'Talaria doesn’t need Hermes Agent anymore'}>
      {result ? (
        <div className="mt-3 space-y-4">
          <div className={result.ok ? 'flex items-start gap-3 text-[13.5px] leading-relaxed text-ink' : 'flex items-start gap-3 bg-warn-soft px-3 py-2.5 text-[13px] leading-relaxed text-ink'}>
            {result.ok ? <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={3} /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />}
            <span className="min-w-0 break-words">
              {result.ok ? `${size(result.freedBytes)} freed. Talaria keeps working exactly as before.` : result.message}
              {!result.ok && result.freedBytes > 0 && ` ${size(result.freedBytes)} freed so far.`}
            </span>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-4 text-[13.5px] leading-relaxed text-muted">
          <p>
            Talaria now talks to your AI account itself, so <strong className="font-semibold text-ink">Hermes Agent</strong>, the separate AI program it used to need, isn't used anymore. Your sign-ins have already been moved into Talaria, so nothing changes in how Talaria works.
          </p>
          <div className="flex items-center gap-2.5 border border-line bg-card px-3 py-2.5 text-[13px] text-ink">
            <HardDrive className="size-4 shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              Removing it frees about <strong className="font-semibold">{size(offer.sizeBytes)}</strong>
              {offer.home && <span className="block text-[12px] break-all text-faint">{offer.home}</span>}
            </span>
          </div>
          {removing ? (
            <div className="flex items-start gap-2.5 border border-line px-3 py-2.5 text-[13px] text-ink">
              <Loader className="mt-0.5 size-4 shrink-0 animate-spin text-faint" />
              <span className="min-w-0 flex-1">
                {live?.stage || 'Removing'}…
                <span className="block text-[12px] text-faint">This can take several minutes on some computers. You can close this window: Talaria keeps going and tells you when it's done. Just don't quit Talaria itself until then.</span>
              </span>
            </div>
          ) : (
            <>
              <p className="text-[12.5px]">This removes Hermes Agent completely, including its own settings and chat history. If you use Hermes Agent for anything besides Talaria, keep it.</p>
              <p className="text-[12.5px] text-faint">You'll only see this once. You can always remove it later yourself.</p>
            </>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {removing ? (
              <Button variant="primary" onClick={close}>
                Close, keep removing
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={close}>
                  Keep it
                </Button>
                <Button variant="primary" icon={<Trash2 className="size-4" />} onClick={remove}>
                  Remove Hermes Agent
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
