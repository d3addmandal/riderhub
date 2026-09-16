import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Ride, RideStatus, RidePoint, StopKind, Poi, PoiKind } from '../types';
import { Button, Card, Input, Modal, Spinner, Empty, Badge, Textarea, Icon } from '../components/ui';
import { formatCurrency, formatDate } from '../lib/utils';
import PlacePicker from '../components/common/PlacePicker';
import RideNotes from '../components/rides/RideNotes';
import ShareInvite from '../components/common/ShareInvite';
import RideMembers from '../components/rides/RideMembers';
import StopKindPicker from '../components/rides/StopKindPicker';
import NearbyFinder, { FindScope } from '../components/rides/NearbyFinder';
import PlaceDetailSheet from '../components/rides/PlaceDetailSheet';
import { stopMeta, plannedStopMinutes, POI_KIND_META } from '../lib/stopKinds';

const STATUS_BADGE: Record<RideStatus, { variant: 'success' | 'warning' | 'info' | 'danger' | 'default'; label: string }> = {
  planned:   { variant: 'info',    label: 'Planned' },
  active:    { variant: 'success', label: 'Active' },
  paused:    { variant: 'warning', label: 'Paused' },
  completed: { variant: 'default', label: 'Completed' },
  cancelled: { variant: 'danger',  label: 'Cancelled' },
};

function duration(ms?: number | null): string {
  if (!ms) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function fmtMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export default function RideDetailPage() {
  const { rideId } = useParams<{ rideId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [showFinish, setShowFinish] = useState(false);
  const [showStop, setShowStop] = useState(false);
  const [newStop, setNewStop] = useState<RidePoint | null>(null);
  const [newStopKind, setNewStopKind] = useState<StopKind>('break');
  const [newStopMinutes, setNewStopMinutes] = useState<number | null>(null);
  const [error, setError] = useState('');
  /** Which place we are searching around, and for what. */
  const [finder, setFinder] = useState<null | { scopeId: string; kind: PoiKind }>(null);
  /** The rider's own position, fetched only when they ask to search near themselves. */
  const [herePos, setHerePos] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  /** The place whose full card is open — rating, photos, reviews. */
  const [openPoi, setOpenPoi] = useState<Poi | null>(null);
  const [finish, setFinish] = useState({ end_odometer: '', fuel_litres: '', fuel_cost: '', other_cost: '', notes: '' });

  const { data: ride, isLoading } = useQuery<Ride>({
    queryKey: ['ride', rideId],
    queryFn: () => api.get(`/rides/${rideId}`),
    enabled: !!rideId,
    // An active ride's distance moves as the odometer does.
    refetchInterval: q => (q.state.data as Ride | undefined)?.status === 'active' ? 30000 : false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ride', rideId] });
    qc.invalidateQueries({ queryKey: ['rides'] });
    qc.invalidateQueries({ queryKey: ['bike-dashboard'] });
    qc.invalidateQueries({ queryKey: ['bikes'] });
  };

  const act = useMutation({
    mutationFn: (action: string) => api.post(`/rides/${rideId}/${action}`, {}),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const addStop = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.post(`/rides/${rideId}/stops`, p),
    onSuccess: () => {
      refresh(); setShowStop(false); setNewStop(null);
      setNewStopKind('break'); setNewStopMinutes(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const patchStop = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/rides/${rideId}/stops/${id}`, body),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const reachStop = useMutation({
    mutationFn: (stopIdValue: string) => api.post(`/rides/${rideId}/stops/${stopIdValue}/reached`, {}),
    onSuccess: refresh,
  });

  const removeStop = useMutation({
    mutationFn: (stopIdValue: string) => api.delete(`/rides/${rideId}/stops/${stopIdValue}`),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const reorder = useMutation({
    mutationFn: (order: string[]) => api.put(`/rides/${rideId}/stops/reorder`, { order }),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const complete = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/rides/${rideId}/complete`, body),
    onSuccess: () => { refresh(); setShowFinish(false); setError(''); },
    onError: (e: Error) => setError(e.message),
  });

  const removeRide = useMutation({
    mutationFn: () => api.delete(`/rides/${rideId}`),
    onSuccess: () => { refresh(); navigate('/rides'); },
  }); if (isLoading) return <div className="h-full flex items-center justify-center"><Spinner size="lg" /></div>;
  if (!ride) {
    return <div className="p-4"><Empty title="Ride not found" action={<Button onClick={() => navigate('/rides')}>Back to rides</Button>} /></div>;
  }

  const live = ride.status === 'active' || ride.status === 'paused';
  const stops = [...(ride.stops ?? [])].sort((a, b) => a.order - b.order);
  const nextStop = stops.find(s => !s.reached_at);
  const canEditRoute = ride.status !== 'completed' && ride.status !== 'cancelled';

  /**
   * Every place worth searching from: the rider's own position, the start, each stop,
   * and the destination. The same list wherever the sheet is opened, so the answer to
   * "where?" is never fixed by which button was pressed.
   */
  const findScopes: FindScope[] = [
    {
      id: 'me', label: 'Near me', icon: '', at: herePos,
      disabled: herePos ? undefined : (locating ? 'Getting your position…' : 'Tap  Near me to use your position.'),
    },
    ...(ride.start_location?.name ? [{
      id: 'start', label: ride.start_location.name, icon: '',
      at: ride.start_location.lat != null
        ? { lat: ride.start_location.lat, lng: ride.start_location.lng! } : null,
      disabled: ride.start_location.lat != null ? undefined : 'No position for the start.',
    }] : []),
    ...stops.map((s, i) => ({
      id: s.id,
      label: `${i + 1}. ${s.name}`,
      icon: stopMeta(s.kind).icon,
      at: s.lat != null ? { lat: s.lat, lng: s.lng! } : null,
      disabled: s.lat != null ? undefined : 'This stop has no position yet.',
    })),
    ...(ride.destination?.name ? [{
      id: 'dest', label: ride.destination.name, icon: '',
      at: ride.destination.lat != null
        ? { lat: ride.destination.lat, lng: ride.destination.lng! } : null,
      disabled: ride.destination.lat != null ? undefined : 'No position for the destination.',
    }] : []),
  ];

  /** Ask for GPS only when the rider actually wants a search around themselves. */
  function findNearMe(kind: PoiKind) {
    setFinder({ scopeId: 'me', kind });
    if (herePos || !navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      p => { setHerePos({ lat: p.coords.latitude, lng: p.coords.longitude }); setLocating(false); },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  /** Shuffle a stop one place along and persist the whole order. */
  function moveStop(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= stops.length) return;
    const ids = stops.map(s => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    reorder.mutate(ids);
  }

  function openFinish() {
    setFinish({
      end_odometer: ride!.current_odometer != null ? String(ride!.current_odometer) : '',
      fuel_litres: '', fuel_cost: '', other_cost: '', notes: ride!.notes ?? '',
    });
    setError('');
    setShowFinish(true);
  }

  function submitFinish() {
    const end = finish.end_odometer ? parseInt(finish.end_odometer, 10) : undefined;
    if (finish.end_odometer && (!Number.isFinite(end!) || end! < 0)) {
      setError('Closing odometer must be a positive number.'); return;
    }
    if (end != null && ride!.start_odometer != null && end < ride!.start_odometer) {
      setError(`Closing reading is below the opening ${ride!.start_odometer.toLocaleString()} km.`); return;
    }
    setError('');
    complete.mutate({
      end_odometer: end,
      fuel_litres: finish.fuel_litres ? parseFloat(finish.fuel_litres) : undefined,
      fuel_cost: finish.fuel_cost ? parseFloat(finish.fuel_cost) : undefined,
      other_cost: finish.other_cost ? parseFloat(finish.other_cost) : undefined,
      notes: finish.notes.trim() || undefined,
    });
  }

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4 pb-6">

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-ink truncate">{ride.name}</h1>
            <p className="text-muted text-xs">
              {ride.bike_name} · <span className="capitalize">{ride.ride_type}</span>
              {ride.started_at ? ` · ${formatDate(ride.started_at)}` : ride.planned_date ? ` · planned ${formatDate(ride.planned_date)}` : ''}
            </p>
          </div>
          <Badge variant={STATUS_BADGE[ride.status].variant}>{STATUS_BADGE[ride.status].label}</Badge>
        </div>

        {ride.invite_code && (
          <Card className="py-3">
            <ShareInvite code={ride.invite_code} rideName={ride.name} />
          </Card>
        )}

        {error && <p className="text-danger text-sm">{error}</p>}

        {/* Ride controls (spec §51) */}
        <div className="flex flex-col gap-2">
          {ride.status === 'planned' && (
            <>
              {/* Planning happens on the same map the ride itself uses, so the route you
                  lay out beforehand is exactly the one you will be navigated along. */}
              <Button fullWidth variant="outline" onClick={() => navigate(`/rides/${ride.id}/map`)}>Plan the route on the map
              </Button>
              <div className="flex gap-2">
                <Button fullWidth loading={act.isPending} onClick={() => act.mutate('start')}>Start ride</Button>
                <Button variant="ghost" onClick={() => { if (confirm('Cancel this ride?')) act.mutate('cancel'); }}>Cancel</Button>
              </div>
            </>
          )}
          {live && (
            <div className="flex gap-2">
              {ride.status === 'active' ? (
                <>
                  <Button fullWidth onClick={() => navigate(`/rides/${ride.id}/map`)}>Open map</Button>
                  <Button variant="outline" loading={act.isPending} onClick={() => act.mutate('pause')}>Pause</Button>
                </>
              ) : (
                <>
                  <Button fullWidth loading={act.isPending} onClick={() => act.mutate('resume')}>Resume</Button>
                  <Button variant="outline" onClick={() => navigate(`/rides/${ride.id}/map`)}>Map</Button>
                </>
              )}
              <Button variant="secondary" onClick={openFinish}>Finish</Button>
            </div>
          )}
        </div>

        {/* Statistics (spec §12) */}
        <div className="grid grid-cols-2 gap-3">
          <Card className="flex flex-col gap-0.5">
            <span className="text-muted text-[10px] uppercase tracking-wider">Distance</span>
            <span className="text-xl font-black text-ink tabular-nums">
              {ride.distance_km != null ? `${ride.distance_km.toLocaleString()} km` : '—'}
            </span>
            {ride.planned_distance != null && (
              <span className="text-muted text-[11px]">~{ride.planned_distance} km planned</span>
            )}
          </Card>
          <Card className="flex flex-col gap-0.5">
            <span className="text-muted text-[10px] uppercase tracking-wider">Duration</span>
            <span className="text-xl font-black text-ink tabular-nums">{duration(ride.duration_ms)}</span>
            {ride.avg_speed != null && <span className="text-muted text-[11px]">avg {ride.avg_speed} km/h</span>}
          </Card>
          <Card className="flex flex-col gap-0.5">
            <span className="text-muted text-[10px] uppercase tracking-wider">Mileage</span>
            <span className="text-xl font-black text-green-400 tabular-nums">
              {ride.mileage != null ? `${ride.mileage} km/L` : '—'}
            </span>
            {ride.fuel_litres != null && <span className="text-muted text-[11px]">{ride.fuel_litres} L used</span>}
          </Card>
          <Card className="flex flex-col gap-0.5">
            <span className="text-muted text-[10px] uppercase tracking-wider">Ride cost</span>
            <span className="text-xl font-black text-orange-400 tabular-nums">
              {formatCurrency(ride.total_cost ?? 0)}
            </span>
            {ride.distance_km ? (
              <span className="text-muted text-[11px]">
                ₹{((ride.total_cost ?? 0) / Math.max(1, ride.distance_km)).toFixed(2)}/km
              </span>
            ) : null}
          </Card>
        </div>

        {ride.max_speed != null && (
          <p className="text-muted text-xs">Top speed recorded: {ride.max_speed} km/h</p>
        )}

        {/* Fuel bought during this ride (spec §21) */}
        {!!ride.fuel_entries?.length && (
          <div className="flex flex-col gap-2">
            <h2 className="font-semibold text-ink text-sm">Fuel on this ride</h2>
            {ride.fuel_entries.map(f => (
              <Card key={f.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-ink text-sm">{f.litres} L · {formatDate(f.date)}</p>
                  <p className="text-muted text-xs truncate">
                    {f.station || 'Station not recorded'} · {f.odometer.toLocaleString()} km
                  </p>
                </div>
                <span className="text-ink text-sm tabular-nums flex-shrink-0">
                  {formatCurrency(f.amount)}
                </span>
              </Card>
            ))}
            <p className="text-muted text-[11px]">Logged in the fuel log and counted here — one entry, both places.
            </p>
          </div>
        )}

        {/* Route (spec §13) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-ink text-sm">Route</h2>
              {!!stops.length && (
                <p className="text-muted text-[11px]">
                  {stops.length} {stops.length === 1 ? 'stop' : 'stops'} ·{' '}
                  {fmtMinutes(plannedStopMinutes(stops))} planned off the bike
                </p>
              )}
            </div>
            {canEditRoute && (
              <Button size="sm" variant="ghost" onClick={() => { setError(''); setShowStop(true); }}>+ Stop</Button>
            )}
          </div>

          <div className="flex flex-col">
            <RouteNode icon="A" label={ride.start_location?.name ?? 'Start'}
                       sub={ride.start_odometer != null ? `${ride.start_odometer.toLocaleString()} km` : undefined} done />
            {stops.map((s, i) => (
              <RouteNode
                key={s.id}
                // The number matches the stop's pin on the map, so the two never disagree.
                icon={s.reached_at ? '' : String(i + 1)}
                label={`${stopMeta(s.kind).icon} ${s.name}`}
                sub={
                  s.reached_at ? `Reached ${formatDate(s.reached_at)}`
                    : s.lat == null ? 'No position — navigation cannot route here': [
                        stopMeta(s.kind).label,
                        `${s.planned_minutes ?? stopMeta(s.kind).minutes} min`,
                        nextStop?.id === s.id && live ? 'next stop' : null,
                      ].filter(Boolean).join(' · ')
                }
                warn={s.lat == null}
                done={!!s.reached_at}
                highlight={nextStop?.id === s.id && live}
                action={
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* Fuel, food and beds around this stop — a night stop opens on beds */}
                    {s.lat != null && (
                      <button
                        onClick={() => setFinder({
                          scopeId: s.id,
                          kind: (stopMeta(s.kind).suggests ?? 'fuel') as PoiKind,
                        })}
                        title={`Find fuel, food and stays near ${s.name}`}
                        aria-label={`Find fuel, food and stays near ${s.name}`}
                        className="btn3d btn3d-surface p-1.5 rounded-lg text-muted hover:text-accent hover:bg-surface2 transition-colors"
                      ><Icon name="search" size={14} /></button>
                    )}
                    {canEditRoute && (
                      <>
                        <button onClick={() => moveStop(i, -1)} disabled={i === 0}
                                className="btn3d btn3d-surface bg-surface2 border border-border p-1 rounded-lg text-muted disabled:opacity-20 hover:text-ink" aria-label="Move stop up"><Icon name="up" size={14} /></button>
                        <button onClick={() => moveStop(i, 1)} disabled={i === stops.length - 1}
                                className="btn3d btn3d-surface bg-surface2 border border-border p-1 rounded-lg text-muted disabled:opacity-20 hover:text-ink" aria-label="Move stop down"><Icon name="down" size={14} /></button>
                      </>
                    )}
                    {live && !s.reached_at && (
                      <Button size="sm" variant="ghost" onClick={() => reachStop.mutate(s.id)}>Reached</Button>
                    )}
                    {canEditRoute && (
                      <button onClick={() => removeStop.mutate(s.id)} aria-label="Remove stop"
                              className="btn3d btn3d-surface p-1.5 rounded-lg text-muted hover:text-danger hover:bg-surface2 transition-colors">
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </div>
                }
              />
            ))}
            <RouteNode icon="B" label={ride.destination?.name ?? 'Destination'} last
                       sub={ride.end_odometer != null ? `${ride.end_odometer.toLocaleString()} km` : undefined}
                       done={ride.status === 'completed'} />
          </div>

          {/* Search around wherever you are, right now — independent of the route */}
          <div className="flex gap-2">
            {(['fuel', 'food', 'lodging'] as PoiKind[]).map(k => (
              <Button key={k} size="sm" variant="outline" className="flex-1"
                      loading={locating && finder?.kind === k}
                      onClick={() => findNearMe(k)}>
                {POI_KIND_META[k].icon} {POI_KIND_META[k].label}
              </Button>
            ))}
          </div>
          <p className="text-muted text-[11px]">Searches around you now. Inside, switch to any stop to check what is near it
            instead — beds by tonight's halt, fuel before the ghat.
          </p>
        </div>

        {/* The note captured when the ride was planned or finished */}
        {ride.notes && (
          <Card>
            <p className="text-muted text-[10px] uppercase tracking-wider mb-1">Ride summary note</p>
            <p className="text-ink text-sm whitespace-pre-wrap">{ride.notes}</p>
          </Card>
        )}

        {ride.ride_type !== 'solo' && (
          <RideMembers rideId={ride.id} live={live} />
        )}

        <RideNotes rideId={ride.id} notes={ride.ride_notes ?? []} canGeotag={live} />

        <Button variant="danger" fullWidth
                onClick={() => { if (confirm('Delete this ride and its recorded track?')) removeRide.mutate(); }}>Delete ride
        </Button>
      </div>

      {/* Add stop */}
      <Modal open={showStop} onClose={() => setShowStop(false)} title="Add a Stop">
        <div className="flex flex-col gap-3">
          <PlacePicker label="Stop" placeholder="Chai break at Khandala"
                       value={newStop} onChange={setNewStop} />

          <StopKindPicker value={newStopKind} onChange={setNewStopKind}
                          minutes={newStopMinutes} onMinutes={setNewStopMinutes} />

          <p className="text-muted text-xs">Added to the end of the route. Pin it to a real place and navigation can route there.
          </p>
          {error && <p className="text-danger text-sm">{error}</p>}
          <Button fullWidth loading={addStop.isPending} disabled={!newStop?.name.trim()}
                  onClick={() => newStop && addStop.mutate({
                    ...newStop,
                    kind: newStopKind,
                    planned_minutes: newStopMinutes ?? stopMeta(newStopKind).minutes,
                  })}>Add Stop</Button>
        </div>
      </Modal>

      {/* Finish (spec §21) */}
      <Modal open={showFinish} onClose={() => setShowFinish(false)} title="Finish Ride">
        <div className="flex flex-col gap-3">
          <Input label="Closing odometer" type="number" inputMode="numeric" value={finish.end_odometer}
                 onChange={e => setFinish(f => ({ ...f, end_odometer: e.target.value }))} />
          <p className="text-muted text-xs">Distance is worked out from the odometer, so it stays right even if GPS dropped out.
            {ride.start_odometer != null && ` Started at ${ride.start_odometer.toLocaleString()} km.`}
          </p>

          {(ride.fuel_from_entries?.count ?? 0) >0 ? (
            <div className="bg-surface2 rounded-xl p-3">
              <p className="text-ink text-sm">
                 {ride.fuel_from_entries!.count} fill-up{ride.fuel_from_entries!.count === 1 ? '' : 's'} already
                logged on this ride — {ride.fuel_from_entries!.litres} L, {formatCurrency(ride.fuel_from_entries!.cost)}
              </p>
              <p className="text-muted text-xs mt-1">Used automatically. Fill the boxes below only to override them.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Input label="Fuel used (L)" type="number" inputMode="decimal" step="0.01" placeholder="Optional"
                   value={finish.fuel_litres} onChange={e => setFinish(f => ({ ...f, fuel_litres: e.target.value }))} />
            <Input label="Fuel cost (₹)" type="number" inputMode="decimal" placeholder="Optional"
                   value={finish.fuel_cost} onChange={e => setFinish(f => ({ ...f, fuel_cost: e.target.value }))} />
          </div>
          <Input label="Other costs (₹)" type="number" inputMode="decimal" placeholder="Tolls, food, parking"
                 value={finish.other_cost} onChange={e => setFinish(f => ({ ...f, other_cost: e.target.value }))} />
          <Textarea label="Notes" rows={2} value={finish.notes}
                    onChange={e => setFinish(f => ({ ...f, notes: e.target.value }))} />

          {error && <p className="text-danger text-sm">{error}</p>}
          <Button fullWidth loading={complete.isPending} onClick={submitFinish}>Complete Ride</Button>
        </div>
      </Modal>

      {/* Fuel, food and beds — near the rider, or near any point on the route */}
      <NearbyFinder
        open={!!finder}
        onClose={() => setFinder(null)}
        scopes={findScopes}
        initialScopeId={finder?.scopeId}
        initialKind={finder?.kind ?? 'fuel'}
        onOpen={p => setOpenPoi(p)}
        addLabel="Add stop"
        onAdd={canEditRoute
          ? async (p: Poi, asKind: StopKind) => {
              await addStop.mutateAsync({
                name: p.name, lat: p.lat, lng: p.lng,
                kind: asKind, planned_minutes: stopMeta(asKind).minutes,
              });
            }
          : undefined}
      />

      {/* The full card for one place: rating, photos, reviews, its page on Google */}
      <PlaceDetailSheet
        poi={openPoi}
        open={!!openPoi}
        onClose={() => setOpenPoi(null)}
        onAdd={canEditRoute
          ? async (p: Poi, asKind: StopKind) => {
              await addStop.mutateAsync({
                name: p.name, lat: p.lat, lng: p.lng,
                kind: asKind, planned_minutes: stopMeta(asKind).minutes,
              });
            }
          : undefined}
      />
    </div>
  );
}

/** One node on the vertical route timeline. */
function RouteNode({ icon, label, sub, done, highlight, last, action, warn }: {
  /** A sequence number, or a short word for the ends of the route. */
  icon?: string; label: string; sub?: string;
  done?: boolean; highlight?: boolean; last?: boolean; action?: React.ReactNode;
  /** The stop has no coordinates, so it cannot be navigated to. */
  warn?: boolean;
}) {
  // A bare number is the stop's sequence; anything else is a glyph and sets its own size.
  const isNumber = !!icon && /^\d+$/.test(icon);

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center flex-shrink-0">
        <span className={`w-8 h-8 rounded-full flex items-center justify-center ${
          isNumber ? 'text-xs font-bold' : 'text-sm'} ${ highlight ? 'bg-accent text-accent-ink ring-2 ring-accent': done ? 'bg-green-500/15': warn ? 'bg-yellow-500/15 text-yellow-400': 'bg-surface2 text-ink'}`}>{icon}</span>
        {!last && <span className={`w-0.5 flex-1 min-h-[18px] ${done ? 'bg-green-500/40' : 'bg-border'}`} />}
      </div>
      <div className="flex-1 min-w-0 pb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-sm truncate ${highlight ? 'text-accent font-semibold' : 'text-ink'}`}>{label}</p>
          {sub && <p className={`text-[11px] ${warn ? 'text-yellow-400' : 'text-muted'}`}>{sub}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}
