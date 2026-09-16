import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { PlaceDetail, Poi, StopKind } from '../../types';
import { Button, Modal, Icon, Spinner } from '../ui';
import { POI_KIND_META } from '../../lib/stopKinds';

/**
 * The full card for one place: rating, photos, reviews, hours, and a way through to the
 * vendor's own page on Google.
 *
 * This is the screen a rider reads before deciding a detour is worth it, so the parts
 * that answer "is it any good and is it open" come first, and the long tail — the review
 * text — is scrollable underneath.
 */
export default function PlaceDetailSheet({ poi, open, onClose, onAdd, addKind }: {
  poi: Poi | null;
  open: boolean;
  onClose: () => void;
  onAdd?: (poi: Poi, asKind: StopKind) => Promise<void> | void;
  addKind?: StopKind;
}) {
  const [detail, setDetail] = useState<PlaceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);

  // Blob URLs are only freed when we free them, so every fetched photo is tracked.
  const created = useRef<string[]>([]);
  const revokeAll = () => {
    created.current.forEach(u => URL.revokeObjectURL(u));
    created.current = [];
  };

  useEffect(() => () => revokeAll(), []);

  useEffect(() => {
    if (!open || !poi) return;
    let cancelled = false;

    setDetail(null); setError(''); setPhotoUrls([]); setAdded(false); setShowAllReviews(false);
    revokeAll();
    setLoading(true);

    (async () => {
      try {
        const d = await api.get<PlaceDetail>(`/places/detail?id=${encodeURIComponent(poi.id)}`);
        if (cancelled) return;
        setDetail(d);

        // Photos come through our API for the key's sake, so each needs fetching as a
        // blob. Failures are silent — a missing photo should not break the card.
        const urls = await Promise.all(d.photos.slice(0, 6).map(p => api.blobUrl(`${p}&w=800`).catch(() => null)));
        if (cancelled) { urls.forEach(u => u && URL.revokeObjectURL(u)); return; }

        const ok = urls.filter(Boolean) as string[];
        created.current = ok;
        setPhotoUrls(ok);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Could not load this place.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, poi?.id]);

  if (!poi) return null;
  const meta = POI_KIND_META[poi.kind];
  const reviews = detail?.reviews ?? [];
  const shownReviews = showAllReviews ? reviews : reviews.slice(0, 3);

  return (
    <Modal open={open} onClose={onClose} title={`${meta.icon} ${poi.name}`}>
      <div className="flex flex-col gap-3">

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10">
            <Spinner /> <span className="text-muted text-sm">Loading details…</span>
          </div>
        )}

        {error && (
          <div className="flex flex-col gap-2">
            <p className="text-danger text-sm">{error}</p>
            {/* Even with no detail, the basics from the search are still useful. */}
            <p className="text-muted text-xs">{poi.address}</p>
          </div>
        )}

        {detail && (
          <>
            {/* Rating first — it is what decides whether the detour happens */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-ink font-bold">{detail.name}</p>
                <p className="text-muted text-xs">{detail.address}</p>
              </div>
              {detail.rating != null && (
                <div className="text-right flex-shrink-0">
                  <p className="text-ink font-black text-lg leading-none tabular-nums">
                    {detail.rating.toFixed(1)}
                  </p>
                  <Stars value={detail.rating} />
                  <p className="text-muted text-[10px]">
                    {detail.rating_count?.toLocaleString() ?? 0} reviews
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {detail.open_now === true && (
                <span className="px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-semibold">Open now</span>
              )}
              {detail.open_now === false && (
                <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 font-semibold">Closed</span>
              )}
              {detail.price_level && (
                <span className="px-2 py-0.5 rounded-full bg-surface2 text-muted">
                  {priceLabel(detail.price_level)}
                </span>
              )}
              <span className="text-muted">{fmtKm(poi.detour_m)} away</span>
            </div>

            {detail.summary && <p className="text-muted text-xs leading-relaxed">{detail.summary}</p>}

            {/* Photos — a horizontal strip, scrolled with a thumb */}
            {!!photoUrls.length && (
              <div className="flex gap-2 overflow-x-auto scroll-y -mx-1 px-1 pb-1">
                {photoUrls.map((u, i) => (
                  <img
                    key={i}
                    src={u}
                    alt={`${detail.name} photo ${i + 1}`}
                    loading="lazy"
                    className="h-36 w-52 object-cover rounded-xl flex-shrink-0 bg-surface2"
                  />
                ))}
              </div>
            )}

            {/* Contact and hours */}
            <div className="flex flex-col gap-1.5">
              {detail.phone && (
                <a href={`tel:${detail.phone.replace(/\s/g, '')}`}
                   className="flex items-center gap-2 text-sm text-ink hover:text-accent transition-colors">
                  <span className="w-5 text-center"></span>{detail.phone}
                </a>
              )}
              {detail.website && (
                <a href={detail.website} target="_blank" rel="noopener noreferrer"
                   className="flex items-center gap-2 text-sm text-ink hover:text-accent transition-colors truncate">
                  <span className="w-5 text-center flex-shrink-0"></span>
                  <span className="truncate">{hostOf(detail.website)}</span>
                </a>
              )}
              {!!detail.hours.length && <Hours lines={detail.hours} />}
            </div>

            {/* Reviews */}
            {!!reviews.length && (
              <div className="flex flex-col gap-2">
                <p className="text-ink font-semibold text-sm">Reviews</p>
                {shownReviews.map((r, i) => (
                  <div key={i} className="bg-surface2 rounded-xl p-3 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      {r.author_photo
                        ? <img src={r.author_photo} alt="" className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" />
                        : <span className="w-6 h-6 rounded-full bg-border flex items-center justify-center text-[10px]">
                            {r.author.slice(0, 1)}
                          </span>}
                      <span className="text-ink text-xs font-semibold truncate flex-1">{r.author}</span>
                      {r.rating != null && <Stars value={r.rating} />}
                    </div>
                    <p className="text-muted text-xs leading-relaxed whitespace-pre-wrap">{r.text}</p>
                    {r.relative_time && <p className="text-muted text-[10px]">{r.relative_time}</p>}
                  </div>
                ))}
                {reviews.length >3 && (
                  <button onClick={() => setShowAllReviews(v => !v)}
                          className="text-accent text-xs font-semibold self-start">
                    {showAllReviews ? 'Show fewer' : `Show all ${reviews.length} reviews`}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-1">
          {onAdd && !added && (
            <Button fullWidth loading={adding}
                    onClick={async () => {
                      setAdding(true);
                      try {
                        await onAdd(poi, addKind ?? defaultKind(poi.kind));
                        setAdded(true);
                      } catch (e: any) {
                        setError(e.message || 'Could not add that stop.');
                      } finally {
                        setAdding(false);
                      }
                    }}>Add as a stop
            </Button>
          )}
          {added && <p className="text-green-400 text-sm text-center">Added to your route</p>}

          {/* The vendor's own page on Google, opened outside the app */}
          <a
            href={detail?.google_maps_url
              ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${poi.name} ${poi.address}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 w-full py-2.5 rounded-xl
                       border border-border text-ink text-sm font-semibold hover:bg-surface2 transition-colors"
          >
            Open on Google
            <Icon name="forward" size={15} />
          </a>
          <p className="text-muted text-[10px] text-center">Ratings, reviews and photos are from Google. Opening their page leaves RiderHub.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/** Five stars with a half-step, so 4.3 does not read as 4 or 5. */
function Stars({ value }: { value: number }) {
  const full = Math.floor(value);
  const half = value - full >= 0.25 && value - full < 0.75;
  const rounded = value - full >= 0.75 ? full + 1 : full;
  return (
    <span className="text-[11px] text-yellow-400 leading-none" title={`${value.toFixed(1)} out of 5`}>
      {''.repeat(half ? full : rounded)}{half ? '⯪' : ''}
      <span className="text-muted">{''.repeat(Math.max(0, 5 - (half ? full + 1 : rounded)))}</span>
    </span>
  );
}

/** Opening hours, collapsed to today until asked for the week. */
function Hours({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  // Google returns Monday-first; JS getDay() is Sunday-first.
  const todayIdx = (new Date().getDay() + 6) % 7;
  const today = lines[todayIdx] ?? lines[0];

  return (
    <div className="flex flex-col gap-1">
      <button onClick={() => setOpen(v => !v)} className="flex items-center gap-2 text-sm text-ink text-left">
        <span className="w-5 text-center flex-shrink-0"></span>
        <span className="flex-1 truncate">{today}</span>
        <Icon name="chevronDown" size={14}
              className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="pl-7 flex flex-col gap-0.5">
          {lines.map((l, i) => (
            <p key={i} className={`text-xs ${i === todayIdx ? 'text-ink' : 'text-muted'}`}>{l}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function defaultKind(kind: Poi['kind']): StopKind {
  switch (kind) {
    case 'fuel': return 'fuel';
    case 'lodging': return 'night';
    case 'food': return 'lunch';
    default: return 'break';
  }
}

function priceLabel(level: string) {
  const map: Record<string, string> = {
    PRICE_LEVEL_FREE: 'Free',
    PRICE_LEVEL_INEXPENSIVE: '₹',
    PRICE_LEVEL_MODERATE: '₹₹',
    PRICE_LEVEL_EXPENSIVE: '₹₹₹',
    PRICE_LEVEL_VERY_EXPENSIVE: '₹₹₹₹',
  };
  return map[level] ?? level;
}

function hostOf(url: string) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

function fmtKm(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
