import { useState } from 'react';
import { Button } from '../ui';

/**
 * Hand the invite code to whoever is riding along.
 *
 * The native share sheet is the right answer where it exists: it lists whatever the
 * rider actually uses — WhatsApp, SMS, Telegram, Signal — without this app having to
 * know about any of them, and it works on a locked-down phone where deep links to
 * individual apps may not.
 *
 * Desktop browsers mostly lack it, so there are direct links behind it, and a copy
 * button behind those. Something always works.
 */
export default function ShareInvite({ code, rideName, joinUrl }: {
  code: string;
  rideName?: string;
  /** Where a tap on the link should land. Defaults to this app. */
  joinUrl?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [showLinks, setShowLinks] = useState(false);

  const url = joinUrl ?? `${window.location.origin}/rides/join?code=${encodeURIComponent(code)}`;
  const text = rideName
    ? `Join my ride "${rideName}" on RiderHub. Code: ${code}`
    : `Join my ride on RiderHub. Code: ${code}`;
  const full = `${text}\n${url}`;

  const canShare = typeof navigator.share === 'function';

  async function share() {
    try {
      await navigator.share({ title: 'RiderHub ride invite', text, url });
    } catch (e: any) {
      // A cancelled share sheet is not a failure worth reporting.
      if (e?.name !== 'AbortError') setShowLinks(true);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setShowLinks(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-muted text-[10px] uppercase tracking-wider">Invite code</p>
          <p className="text-accent font-mono font-bold text-xl tracking-widest">{code}</p>
        </div>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {canShare && <Button size="sm" onClick={() => void share()}>Share</Button>}
      </div>

      {(!canShare || showLinks) && (
        <div className="flex gap-2">
          <a href={`https://wa.me/?text=${encodeURIComponent(full)}`}
             target="_blank" rel="noopener noreferrer" className="flex-1">
            <span className="btn3d btn3d-surface bg-surface2 text-ink border border-border
                             flex items-center justify-center rounded-xl py-2 text-xs font-semibold">
              WhatsApp
            </span>
          </a>
          <a href={`sms:?&body=${encodeURIComponent(full)}`} className="flex-1">
            <span className="btn3d btn3d-surface bg-surface2 text-ink border border-border
                             flex items-center justify-center rounded-xl py-2 text-xs font-semibold">
              SMS
            </span>
          </a>
          <a href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`}
             target="_blank" rel="noopener noreferrer" className="flex-1">
            <span className="btn3d btn3d-surface bg-surface2 text-ink border border-border
                             flex items-center justify-center rounded-xl py-2 text-xs font-semibold">
              Telegram
            </span>
          </a>
        </div>
      )}

      {!canShare && (
        <p className="text-muted text-[10px]">
          This browser has no share sheet, so the apps are linked directly.
        </p>
      )}
    </div>
  );
}
