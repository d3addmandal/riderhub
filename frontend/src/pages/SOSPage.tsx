import { useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { Button, Card, Spinner, IconButton } from '../components/ui';
import { formatDate } from '../lib/utils';

interface SOSEvent { id: string; lat: number; lng: number; address?: string; message: string; created_at: string; maps_link?: string; }

/** A pre-filled link the phone must open — the server cannot send these itself. */
interface Channel { name: string; kind: 'sms' | 'whatsapp' | 'call'; to: string; url: string }

interface SOSResult {
  maps_link: string;
  alert_text: string;
  sent_to: string[];
  telegram_failed?: string;
  channels: Channel[];
  auto_sent: boolean;
  needs_tap: number;
}

/** How long the button must be held before it dials. */
const HOLD_TO_CALL_MS = 4000;

export default function SOSPage() {
  const navigate = useNavigate();
  const { profile } = useAuthStore();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<SOSResult | null>(null);
  /** 0 to 1 while the rider holds the button down. */
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimer = useRef<number | null>(null);
  const holdStart = useRef(0);

  const { data: history } = useQuery<SOSEvent[]>({ queryKey: ['sos-history'], queryFn: () => api.get('/sos/history') });

  const sos = useMutation({
    mutationFn: (data: { lat: number; lng: number; message?: string }) =>
      api.post<SOSResult>('/sos', data),
    onSuccess: (r) => {
      setResult(r);
      setSent(true); setSending(false); setConfirmOpen(false);
      // Open the first message channel straight away. Browsers only allow one such
      // navigation per gesture, so the rest are offered as buttons below.
      const first = r.channels.find(c => c.kind === 'whatsapp') ?? r.channels.find(c => c.kind === 'sms');
      if (first) window.open(first.url, '_blank');
    },
    onError: (e: Error) => { setError(e.message); setSending(false); },
  });

  /**
   * One tap sends the alert.
   *
   * The location request is given a short fuse and a cached fallback: in a real emergency
   * a rider cannot wait fifteen seconds for a perfect fix, and a slightly stale position
   * is worth far more than none at all.
   */
  function triggerSOS() {
    setSending(true); setError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => sos.mutate({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => { setError('Could not get location: ' + err.message); setSending(false); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  /** The first contact with a number to dial. */
  const callTarget = (profile?.emergency_contacts ?? []).find(c => c.phone)?.phone
    ?? profile?.emergency_contact_phone
    ?? null;

  /**
   * Hold to call.
   *
   * Four seconds is deliberate: dialling by accident from a pocket is worse than useless,
   * and the ring fills as you hold so it is obvious something is about to happen.
   */
  function startHold() {
    if (!callTarget) return;
    holdStart.current = Date.now();
    holdTimer.current = window.setInterval(() => {
      const p = Math.min(1, (Date.now() - holdStart.current) / HOLD_TO_CALL_MS);
      setHoldProgress(p);
      if (p >= 1) {
        cancelHold();
        window.location.href = `tel:${callTarget.replace(/[^\d+]/g, '')}`;
      }
    }, 50);
  }

  function cancelHold() {
    if (holdTimer.current) window.clearInterval(holdTimer.current);
    holdTimer.current = null;
    setHoldProgress(0);
  }

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-5">
        <div className="flex items-center gap-2 pt-1">
          <IconButton icon="back" label="Go back" onClick={() => navigate(-1)} className="-ml-2" />
          <h1 className="text-xl font-bold text-ink">SOS Emergency</h1>
        </div>

        {/* SOS Button */}
        <div className="flex flex-col items-center gap-4 py-8">
          {sent && result ? (
            <div className="w-full flex flex-col items-center gap-3">
              <p className="text-green-400 font-bold text-lg">Alert raised</p>

              {/* Exactly what went out by itself, and what is still waiting on a tap. */}
              <div className="w-full flex flex-col gap-2">
                {result.auto_sent && (
                  <p className="text-green-400 text-sm text-center">
                    Sent automatically to Telegram.
                  </p>
                )}
                {result.telegram_failed && (
                  <p className="text-danger text-sm text-center">
                    Telegram failed: {result.telegram_failed}
                  </p>
                )}
                {!result.auto_sent && (
                  <p className="text-muted text-sm text-center">
                    No automatic channel is set up. Connect Telegram so future alerts send
                    themselves.
                  </p>
                )}

                {result.channels.filter(c => c.kind !== 'call').length > 0 && (
                  <>
                    <p className="text-muted text-xs text-center mt-1">
                      Tap to send. A web page is not allowed to send these on its own:
                    </p>
                    {result.channels.filter(c => c.kind !== 'call').map((c, i) => (
                      <a key={i} href={c.url} target="_blank" rel="noopener noreferrer">
                        <span className="btn3d btn3d-danger bg-danger text-white flex items-center
                                         justify-center rounded-xl py-3 text-sm font-bold">
                          Send {c.kind === 'whatsapp' ? 'WhatsApp' : 'SMS'} to {c.name}
                        </span>
                      </a>
                    ))}
                  </>
                )}

                {result.channels.filter(c => c.kind === 'call').map((c, i) => (
                  <a key={`call${i}`} href={c.url}>
                    <span className="btn3d btn3d-surface bg-surface2 text-ink border border-border
                                     flex items-center justify-center rounded-xl py-3 text-sm font-bold">
                      Call {c.name}
                    </span>
                  </a>
                ))}

                <a href={result.maps_link} target="_blank" rel="noopener noreferrer"
                   className="text-accent text-xs text-center underline">
                  My location
                </a>
              </div>

              <Button variant="ghost" onClick={() => { setSent(false); setResult(null); }}>Done</Button>
            </div>
          ) : confirmOpen ? (
            <div className="w-full bg-surface border border-danger rounded-2xl p-6 flex flex-col gap-4 text-center">
              <p className="text-ink font-bold">Send SOS alert?</p>
              <p className="text-muted text-sm">
                Your location goes to Telegram straight away, and your phone will open a
                pre-filled message for each emergency contact.
              </p>
              <div className="flex gap-3">
                <Button fullWidth variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
                <Button fullWidth variant="danger" loading={sending} onClick={triggerSOS}>Send SOS</Button>
              </div>
            </div>
          ) : (
            <>
              {/*
                One tap raises the alert; holding for four seconds dials instead. The ring
                fills as you hold, so a call never arrives as a surprise.
              */}
              <button
                onClick={() => { if (holdProgress === 0) setConfirmOpen(true); }}
                onPointerDown={startHold}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
                onPointerCancel={cancelHold}
                onContextMenu={e => e.preventDefault()}
                aria-label="Send SOS. Hold for four seconds to call your first emergency contact."
                className="btn3d btn3d-danger relative w-40 h-40 rounded-full bg-danger flex flex-col items-center
                           justify-center text-white font-black text-3xl select-none touch-none
                           shadow-[0_8px_0_0_#7f1d1d,0_14px_24px_-4px_rgba(0,0,0,0.6)]
                           active:translate-y-1.5
                           active:shadow-[0_3px_0_0_#7f1d1d,0_6px_12px_-4px_rgba(0,0,0,0.6)]
                           transition-all"
              >
                {/* The fill ring, drawn from the hold progress. */}
                <svg className="absolute inset-0 -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="5" />
                  <circle cx="50" cy="50" r="46" fill="none" stroke="#ffffff" strokeWidth="5"
                          strokeLinecap="round"
                          strokeDasharray={2 * Math.PI * 46}
                          strokeDashoffset={2 * Math.PI * 46 * (1 - holdProgress)} />
                </svg>
                <span className="relative">SOS</span>
                <span className="relative text-[11px] font-semibold mt-1 opacity-90">
                  {holdProgress > 0
                    ? `Calling in ${Math.ceil(4 - holdProgress * 4)}...`
                    : callTarget ? 'Tap to alert - hold to call' : 'Tap to alert'}
                </span>
              </button>

              <p className="text-muted text-sm text-center max-w-xs">
                {callTarget
                  ? 'Tap to send your location to your emergency contacts. Hold four seconds to call the first one.'
                  : 'Tap to send your location. Add an emergency contact to enable hold-to-call.'}
              </p>
            </>
          )}
          {error && <p className="text-danger text-sm">{error}</p>}
        </div>

        {/* Emergency Profile */}
        <Card>
          <h2 className="font-semibold text-ink mb-3">Emergency Profile</h2>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Name</span>
              <span className="text-ink">{profile?.name || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Blood Group</span>
              <span className={`font-bold ${profile?.blood_group ? 'text-red-400' : 'text-muted'}`}>{profile?.blood_group || 'Not set'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Emergency Contact</span>
              <span className="text-ink">{profile?.emergency_contact_name || 'Not set'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Contact Phone</span>
              <span className="text-ink">{profile?.emergency_contact_phone || 'Not set'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Telegram Alerts</span>
              <span className={profile?.telegram_chat_id ? 'text-green-400' : 'text-muted'}>{profile?.telegram_chat_id ? 'Connected' : 'Not connected'}</span>
            </div>
          </div>
          <Button size="sm" variant="ghost" className="mt-3 w-full" onClick={() => navigate('/profile')}>Update Emergency Info</Button>
        </Card>

        {/* SOS History */}
        {history && history.length >0 && (
          <div>
            <h2 className="font-semibold text-ink mb-3">Recent SOS</h2>
            <div className="flex flex-col gap-2">
              {history.slice(0, 5).map(event => (
                <Card key={event.id} className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-ink">{formatDate(event.created_at)}</p>
                    <p className="text-muted text-xs">{event.address || `${event.lat?.toFixed(4)}, ${event.lng?.toFixed(4)}`}</p>
                  </div>
                  {event.lat && (
                    <a href={`https://maps.google.com/?q=${event.lat},${event.lng}`} target="_blank" rel="noreferrer">
                      <Button size="sm" variant="ghost">Map</Button>
                    </a>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
