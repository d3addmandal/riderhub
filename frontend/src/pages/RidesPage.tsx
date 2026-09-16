import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Ride, RideStatus, RideType, Motorcycle, RidePoint, StopKind } from '../types';
import { Button, Card, Input, Select, Modal, Empty, Badge, Textarea, Chip, ChipTile, Icon, IconButton } from '../components/ui';
import PlacePicker from '../components/common/PlacePicker';
import { STOP_KIND_META, STOP_KIND_ORDER, stopMeta, plannedStopMinutes } from '../lib/stopKinds';
import { pruneFinishedPacks } from '../lib/offlineRide';
import JoinRide from '../components/rides/JoinRide';
import { formatDate } from '../lib/utils';
import { useGarageStore } from '../store/garageStore';

const STATUS_BADGE: Record<RideStatus, { variant: 'success' | 'warning' | 'info' | 'danger' | 'default'; label: string }> = {
  planned:   { variant: 'info',    label: 'Planned' },
  active:    { variant: 'success', label: 'Active' },
  paused:    { variant: 'warning', label: 'Paused' },
  completed: { variant: 'default', label: 'Completed' },
  cancelled: { variant: 'danger',  label: 'Cancelled' },
};

const TYPE_ICON: Record<RideType, string> = { solo: '🏍️', duo: '', group: '' };

interface StopDraft { key: string; point: RidePoint | null; kind: StopKind; minutes: number | null }

export default function RidesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { selectedBikeId } = useGarageStore();

  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [filter, setFilter] = useState<'all' | RideStatus>('all');
  const [error, setError] = useState('');
  /** How many finished rides had their offline copy cleared on this visit. */
  const [freed, setFreed] = useState(0);

  const [form, setForm] = useState({
    name: '', ride_type: 'solo' as RideType, motorcycle_id: '',
    start_odometer: '', planned_date: new Date().toISOString().split('T')[0], notes: '',
  });
  const [destination, setDestination] = useState<RidePoint | null>(null);
  const [startPoint, setStartPoint] = useState<RidePoint | null>(null);
  const [stops, setStops] = useState<StopDraft[]>([]);

  const { data: bikes } = useQuery<Motorcycle[]>({ queryKey: ['bikes'], queryFn: () => api.get('/bikes') });
  const { data: rides, isLoading } = useQuery<Ride[]>({ queryKey: ['rides'], queryFn: () => api.get('/rides') });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Ride>('/rides', body),
    onSuccess: (ride) => {
      qc.invalidateQueries({ queryKey: ['rides'] });
      setShowCreate(false);
      resetForm();
      navigate(`/rides/${ride.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  function resetForm() {
    setForm({
      name: '', ride_type: 'solo', motorcycle_id: '',
      start_odometer: '', planned_date: new Date().toISOString().split('T')[0], notes: '',
    });
    setDestination(null);
    setStartPoint(null);
    setStops([]);
    setError('');
  }

  function openCreate() {
    const bike = bikes?.find(b => b.id === selectedBikeId) ?? bikes?.[0];
    resetForm();
    setForm(f => ({
      ...f,
      motorcycle_id: bike?.id ?? '',
      start_odometer: bike ? String(bike.current_odometer) : '',
    }));
    setShowCreate(true);
  }

  function submit(startNow: boolean) {
    if (!form.name.trim())        { setError('Give the ride a name.'); return; }
    if (!form.motorcycle_id)      { setError('Choose which bike you are taking.'); return; }
    if (!destination?.name.trim()){ setError('Where are you heading?'); return; }

    const odo = form.start_odometer ? parseInt(form.start_odometer, 10) : undefined;
    if (form.start_odometer && (!Number.isFinite(odo!) || odo! < 0)) {
      setError('Starting odometer must be a positive number.'); return;
    }

    setError('');
    create.mutate({
      name: form.name.trim(),
      ride_type: form.ride_type,
      motorcycle_id: form.motorcycle_id,
      planned_date: form.planned_date || undefined,
      start_location: startPoint?.name.trim() ? startPoint : undefined,
      destination,
      start_odometer: odo,
      stops: stops
        .filter(s => s.point?.name.trim())
        .map(s => ({
          ...s.point!,
          kind: s.kind,
          planned_minutes: s.minutes ?? stopMeta(s.kind).minutes,
        })),
      notes: form.notes.trim() || undefined,
      start_now: startNow,
    });
  }

  /** How many route points still lack coordinates — navigation needs them. */
  const unpinned = [
    destination,
    ...stops.map(s => s.point),
  ].filter(p => p?.name.trim() && p.lat == null).length;

  const shown = (rides ?? []).filter(r => filter === 'all' || r.status === filter);
  const active = (rides ?? []).find(r => r.status === 'active' || r.status === 'paused');

  /**
   * Clear offline copies of rides that are over.
   *
   * The map screen drops a pack the moment its own ride ends, but that misses a ride
   * finished on another device or deleted while this phone was offline. This list is the
   * one place that sees every ride's real status, so the sweep belongs here.
   */
  useEffect(() => {
    if (!rides) return;
    const byId = new Map(rides.map(r => [r.id, r.status]));

    pruneFinishedPacks(id => {
      const status = byId.get(id);
      if (!status) return 'gone';
      return status === 'completed' || status === 'cancelled' ? 'finished' : 'keep';
    })
      .then(removed => { if (removed.length) setFreed(removed.length); })
      .catch(() => { /* offline storage unavailable — nothing to clean */ });
  }, [rides]);

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4 pb-6">

        <div className="flex items-center justify-between pt-1">
          <div>
            <h1 className="text-xl font-bold text-ink">Rides</h1>
            <p className="text-muted text-xs">Plan a route, ride it, keep the numbers</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowJoin(true)}>Join</Button>
            <Button size="sm" onClick={openCreate} disabled={!bikes?.length}>+ New Ride</Button>
          </div>
        </div>

        {/* Resume banner — one tap back into a ride in progress (spec §2.1) */}
        {active && (
          <Card className="border-accent/50 bg-accent/10 flex items-center gap-3" onClick={() => navigate(`/rides/${active.id}`)}>
            <span className="text-2xl">{active.status === 'paused' ? '⏸' : ''}</span>
            <div className="flex-1 min-w-0">
              <p className="text-ink font-semibold text-sm truncate">{active.name}</p>
              <p className="text-muted text-xs">
                {active.status === 'paused' ? 'Paused — tap to resume' : 'Ride in progress — tap to open'}
              </p>
            </div>
            <Icon name="chevronRight" size={18} className="text-accent" />
          </Card>
        )}

        {freed >0 && (
          <p className="text-muted text-[11px]">Cleared the offline copy of {freed} finished {freed === 1 ? 'ride' : 'rides'} to free up space.
          </p>
        )}

        {!bikes?.length && (
          <Empty icon="🏍️" title="Add a bike first" desc="Every ride is logged against a motorcycle" />
        )}

        {/* Status filter */}
        {!!rides?.length && (
          <div className="chip-row">
            {(['all', 'planned', 'active', 'completed'] as const).map(f => {
              const n = f === 'all' ? rides.length : rides.filter(r => r.status === f).length;
              return (
                <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : STATUS_BADGE[f].label}
                  <span className={filter === f ? 'opacity-75' : 'text-muted'}>{n}</span>
                </Chip>
              );
            })}
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map(i => <div key={i} className="h-20 rounded-2xl bg-surface animate-pulse" />)}
          </div>
        ) : !shown.length ? (
          <Empty
           
            title={rides?.length ? 'Nothing here' : 'No rides yet'}
            desc={rides?.length ? 'Try another filter' : 'Plan a solo run with your stops, or start one right now.'} action={bikes?.length ? <Button onClick={openCreate}>Plan a Ride</Button> : undefined}
          />
        ) : (
          /* Ride dashboard (spec §11): SL, name, bike, type, status */
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[24px_1fr_auto] gap-3 px-3 text-[10px] uppercase tracking-wider text-muted">
              <span>SL</span><span>Ride</span><span>Status</span>
            </div>
            {shown.map((ride, i) => (
              <Card
                key={ride.id}
                className="grid grid-cols-[24px_1fr_auto] gap-3 items-center py-3"
                onClick={() => navigate(`/rides/${ride.id}`)}
              >
                <span className="text-muted text-xs tabular-nums">{shown.length - i}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span>{TYPE_ICON[ride.ride_type]}</span>
                    <p className="font-semibold text-ink text-sm truncate">{ride.name}</p>
                  </div>
                  <p className="text-muted text-xs truncate">
                    {ride.bike_name ?? 'Bike'} · {ride.ride_type}
                    {ride.destination?.name ? ` · → ${ride.destination.name}` : ''}
                  </p>
                  <p className="text-muted text-xs">
                    {ride.started_at ? formatDate(ride.started_at) : ride.planned_date ? `Planned ${formatDate(ride.planned_date)}` : ''}
                    {ride.distance_km != null ? ` · ${ride.distance_km.toLocaleString()} km` : ''}
                    {ride.stops_count ? ` · ${ride.stops_count} stops` : ''}
                  </p>
                </div>
                <Badge variant={STATUS_BADGE[ride.status].variant}>{STATUS_BADGE[ride.status].label}</Badge>
              </Card>
            ))}
          </div>
        )}
      </div>

      <JoinRide open={showJoin} onClose={() => setShowJoin(false)} />

      {/* Create (spec §13) */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Plan a Ride">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            {(['solo', 'duo', 'group'] as RideType[]).map(t => (
              <ChipTile
                key={t}
                selected={form.ride_type === t}
                icon={TYPE_ICON[t]}
                label={t[0].toUpperCase() + t.slice(1)}
                onClick={() => setForm(f => ({ ...f, ride_type: t }))}
              />
            ))}
          </div>
          {form.ride_type !== 'solo' && (
            <p className="text-muted text-xs">A {form.ride_type} ride gets an invite code so others can join and appear on your map.
            </p>
          )}

          <Input label="Ride name *" placeholder="Sunday breakfast run" value={form.name}
                 onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />

          <Select label="Bike *" value={form.motorcycle_id}
                  onChange={e => {
                    const bike = bikes?.find(b => b.id === e.target.value);
                    setForm(f => ({ ...f, motorcycle_id: e.target.value, start_odometer: bike ? String(bike.current_odometer) : f.start_odometer }));
                  }}>
            <option value="">Select bike</option>
            {(bikes ?? []).map(b => <option key={b.id} value={b.id}>{b.brand} {b.model}</option>)}
          </Select>

          <PlacePicker label="Start from" placeholder="Pune" value={startPoint} onChange={setStartPoint} />
          <PlacePicker label="Destination *" placeholder="Lonavala" value={destination} onChange={setDestination} />

          <div className="grid grid-cols-2 gap-3">
            <Input label="Date" type="date" value={form.planned_date}
                   onChange={e => setForm(f => ({ ...f, planned_date: e.target.value }))} />
            <Input label="Start odometer" type="number" inputMode="numeric" value={form.start_odometer}
                   onChange={e => setForm(f => ({ ...f, start_odometer: e.target.value }))} />
          </div>

          {/* Stops, in order */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-muted">Stops along the way</label>
              <Button size="sm" variant="ghost"
                      onClick={() => setStops(s => [...s, {
                        key: crypto.randomUUID(), point: null, kind: 'break', minutes: null,
                      }])}>
                + Add stop
              </Button>
            </div>

            {!!stops.length && (
              <p className="text-muted text-[11px]">
                ⏱ {plannedStopMinutes(stops.map(s => ({ kind: s.kind, planned_minutes: s.minutes })))} minutes
                planned off the bike across {stops.length} {stops.length === 1 ? 'stop' : 'stops'}.
              </p>
            )}

            {!stops.length && (
              <p className="text-muted text-xs">Optional. Add them in the order you will reach them — navigation follows the list.
              </p>
            )}

            {stops.map((s, i) => (
              <div key={s.key} className="flex items-start gap-2">
                <span className="w-6 text-center text-muted text-xs flex-shrink-0 pt-9">{i + 1}</span>
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <PlacePicker
                    label={`Stop ${i + 1}`}
                    placeholder="Search a place"
                    value={s.point}
                    onChange={p => setStops(list => list.map(x => x.key === s.key ? { ...x, point: p } : x))}
                  />
                  {/* What it is for, chosen inline — the whole plan reads at a glance */}
                  <div className="chip-row">
                    {STOP_KIND_ORDER.map(k => (
                      <Chip
                        key={k}
                        selected={s.kind === k}
                        icon={STOP_KIND_META[k].icon}
                        className="px-2.5 py-1.5 text-[10px] min-h-[32px]"
                        onClick={() => setStops(list => list.map(x => x.key === s.key
                          ? { ...x, kind: k, minutes: STOP_KIND_META[k].minutes } : x))}
                      >
                        {STOP_KIND_META[k].label}
                      </Chip>
                    ))}
                  </div>
                  {s.kind === 'night' && (
                    <p className="text-indigo-300 text-[10px]">Open the ride afterwards to search hotels and hostels around this stop.
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1 flex-shrink-0 pt-7">
                  <IconButton
                    icon="up" label="Move stop up" size={15} variant="solid"
                    className="w-8 h-8 rounded-lg"
                    disabled={i === 0}
                    onClick={() => setStops(list => {
                      if (i === 0) return list;
                      const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n;
                    })}
                  />
                  <IconButton
                    icon="down" label="Move stop down" size={15} variant="solid"
                    className="w-8 h-8 rounded-lg"
                    disabled={i === stops.length - 1}
                    onClick={() => setStops(list => {
                      if (i === list.length - 1) return list;
                      const n = [...list]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n;
                    })}
                  />
                  <IconButton
                    icon="trash" label="Remove stop" size={15} tone="danger"
                    className="w-8 h-8 rounded-lg bg-danger/15 text-danger"
                    onClick={() => setStops(list => list.filter(x => x.key !== s.key))}
                  />
                </div>
              </div>
            ))}
          </div>

          <Textarea label="Notes" rows={2} placeholder="Anything worth remembering…" value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />

          {unpinned >0 && (
            <p className="text-muted text-xs">
               {unpinned} place{unpinned === 1 ? '' : 's'} still {unpinned === 1 ? 'has' : 'have'} no position.
              The ride saves fine, but navigation can only route to pinned places.
            </p>
          )}

          {error && <p className="text-danger text-sm">{error}</p>}

          {/* Two real paths, not a checkbox: plan it for later, or set off now. */}
          <div className="flex flex-col gap-2">
            <Button fullWidth loading={create.isPending} onClick={() => submit(true)}>Create and start now
            </Button>
            <Button fullWidth variant="outline" loading={create.isPending} onClick={() => submit(false)}>Save as planned
            </Button>
            <p className="text-muted text-[11px] text-center">A planned ride keeps its route so you can refine it on the map, then start it
              on the day.
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
