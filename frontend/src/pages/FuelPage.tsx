import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { FuelEntry, Motorcycle } from '../types';
import { Button, Card, Input, Select, Modal, Spinner, Empty, StatCard } from '../components/ui';
import { formatCurrency, formatDate } from '../lib/utils';
import { useGarageStore } from '../store/garageStore';

type Period = 'month' | 'year' | 'all';

interface FuelStats {
  entries: FuelEntry[];
  mileage: number | null;
  total_fuel: number;
  total_cost: number;
  total_distance?: number;
  cost_per_km: number | null;
}

const EMPTY_FORM = {
  motorcycle_id: '', date: '', odometer: '', litres: '',
  amount: '', station: '', fuel_type: 'Petrol', full_tank: true, notes: '',
};

export default function FuelPage() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const { selectedBikeId, setSelectedBike } = useGarageStore();

  const today = new Date().toISOString().split('T')[0];
  const [showAdd, setShowAdd] = useState(false);
  const [period, setPeriod] = useState<Period>('month');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ ...EMPTY_FORM, date: today });

  const { data: bikes, isLoading: bikesLoading, error: bikesError } =
    useQuery<Motorcycle[]>({ queryKey: ['bikes'], queryFn: () => api.get('/bikes') });

  // If a ride is under way, offer to count this fill-up toward it (spec §21).
  const { data: activeRide } = useQuery<{ id: string; name: string; motorcycle_id: string } | null>({
    queryKey: ['active-ride'],
    queryFn: () => api.get('/rides/active'),
  });
  const [attachToRide, setAttachToRide] = useState(true);

  // Bike choice comes from the URL, then the global selection, then the first bike.
  const urlBike = params.get('bike');
  const activeBikeId = urlBike || selectedBikeId || bikes?.[0]?.id || '';

  useEffect(() => {
    if (urlBike) setSelectedBike(urlBike);
  }, [urlBike]);

  const { data: stats, isLoading } = useQuery<FuelStats>({
    queryKey: ['fuel-stats', activeBikeId],
    queryFn: () => api.get(`/fuel/stats/${activeBikeId}`),
    enabled: !!activeBikeId,
  });

  const add = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.post('/fuel', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fuel-stats'] });
      qc.invalidateQueries({ queryKey: ['bikes'] });
      qc.invalidateQueries({ queryKey: ['bike-dashboard'] });
      qc.invalidateQueries({ queryKey: ['ride'] });   // ride cost includes this now
      closeForm();
    },
    onError: (e: Error) => setError(e.message),
    onSettled: () => setSaving(false),
  });

  function openForm() {
    // Pre-select the active bike so a single-bike rider never has to touch the dropdown.
    setForm({ ...EMPTY_FORM, date: today, motorcycle_id: activeBikeId });
    setError('');
    setShowAdd(true);
  }

  function closeForm() {
    setShowAdd(false);
    setForm({ ...EMPTY_FORM, date: today });
    setError('');
  }

  function handleSubmit() {
    // Every failure below used to be a silent `return` — the entry simply vanished.
    if (!form.motorcycle_id) { setError('Choose which bike this fill-up was for.'); return; }
    if (!form.odometer)      { setError('Enter the odometer reading.'); return; }
    if (!form.litres)        { setError('Enter how many litres you put in.'); return; }
    if (!form.amount)        { setError('Enter the amount you paid.'); return; }

    const odometer = parseInt(form.odometer, 10);
    const litres = parseFloat(form.litres);
    const amount = parseFloat(form.amount);

    if (!Number.isFinite(odometer) || odometer < 0) { setError('Odometer must be a positive number.'); return; }
    if (!Number.isFinite(litres) || litres <= 0)    { setError('Litres must be greater than zero.'); return; }
    if (!Number.isFinite(amount) || amount <= 0)    { setError('Amount must be greater than zero.'); return; }

    const bike = bikes?.find(b => b.id === form.motorcycle_id);
    if (bike && odometer < bike.current_odometer) {
      const ok = confirm(
        `This bike already reads ${bike.current_odometer.toLocaleString()} km, but you entered ` +
        `${odometer.toLocaleString()} km.\n\nSave anyway? The bike's odometer will not be lowered.`
      );
      if (!ok) return;
    }

    setSaving(true);
    setError('');
    add.mutate({
      motorcycle_id: form.motorcycle_id,
      date: form.date,
      odometer, litres, amount,
      station: form.station.trim() || undefined,
      fuel_type: form.fuel_type,
      full_tank: form.full_tank,
      notes: form.notes.trim() || undefined,
      // Only attach when the ride is on the same bike, or the totals would be nonsense.
      ride_id: canAttach && attachToRide ? activeRide!.id : undefined,
    });
  }

  // ── Period filtering, newest first ────────────────────────────
  const allEntries = useMemo(
    () => [...(stats?.entries ?? [])].sort((a, b) => b.date.localeCompare(a.date)),
    [stats]
  );

  const filtered = useMemo(() => {
    if (period === 'all') return allEntries;
    const now = new Date();
    const from = period === 'month'? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      : `${now.getFullYear()}-01-01`;
    return allEntries.filter(e => e.date >= from);
  }, [allEntries, period]);

  const periodTotals = useMemo(() => {
    const cost = filtered.reduce((s, e) => s + (e.amount || 0), 0);
    const litres = filtered.reduce((s, e) => s + (e.litres || 0), 0);
    return { cost, litres, count: filtered.length };
  }, [filtered]);

  const bike = bikes?.find(b => b.id === activeBikeId);
  const periodLabel = period === 'month' ? 'This month' : period === 'year' ? 'This year' : 'All time';
  const canAttach = Boolean(activeRide && activeRide.motorcycle_id === form.motorcycle_id);

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4">

        <div className="flex items-center justify-between pt-2">
          <div>
            <h1 className="text-xl font-bold text-ink">Fuel</h1>
            {bike && <p className="text-muted text-xs">{bike.brand} {bike.model} · {bike.current_odometer.toLocaleString()} km</p>}
          </div>
          <Button size="sm" onClick={openForm} disabled={!bikes?.length}>+ Add Fill-up</Button>
        </div>

        {bikesError && (
          <Card className="border-danger/40">
            <p className="text-danger text-sm font-semibold">Could not load your bikes</p>
            <p className="text-muted text-xs mt-1">{(bikesError as Error).message}</p>
          </Card>
        )}

        {!bikesLoading && !bikes?.length && (
          <Empty icon="🏍️" title="Add a bike first" desc="Fuel entries are logged against a motorcycle" />
        )}

        {bikes && bikes.length >1 && (
          <Select value={activeBikeId} onChange={e => setSelectedBike(e.target.value)}>
            {bikes.map(b => <option key={b.id} value={b.id}>{b.brand} {b.model}</option>)}
          </Select>
        )}

        {/* Period filter */}
        {!!bikes?.length && (
          <div className="flex gap-2">
            {(['month', 'year', 'all'] as Period[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`btn3d btn3d-accent flex-1 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                  period === p ? 'bg-accent border-accent text-accent-ink' : 'bg-surface2 border-border text-muted hover:text-ink'}`}
              >
                {p === 'month' ? 'This Month' : p === 'year' ? 'This Year' : 'All Time'}
              </button>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : !bikes?.length ? null : (
          <>
            {/* Period summary */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard label={`${periodLabel} spend`} value={formatCurrency(periodTotals.cost)} color="text-orange-400" />
              <StatCard label={`${periodLabel} fuel`} value={`${periodTotals.litres.toFixed(1)} L`} />
              <StatCard label="Avg mileage" value={stats?.mileage ? `${stats.mileage} km/L` : '—'} color="text-green-400" />
              <StatCard label="Cost / km" value={stats?.cost_per_km ? `₹${stats.cost_per_km}` : '—'} />
            </div>

            {stats && stats.entries.length === 1 && (
              <p className="text-muted text-xs text-center">Log one more fill-up to start seeing mileage — it needs two readings to measure between.
              </p>
            )}

            {!filtered.length ? (
              <Empty
               
                title={allEntries.length ? `No fill-ups ${periodLabel.toLowerCase()}` : 'No fuel entries yet'}
                desc={allEntries.length ? 'Try a wider period' : 'Track every fill-up to see real mileage'} action={<Button onClick={openForm}>Add Fill-up</Button>}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-muted text-xs">{periodTotals.count} fill-up{periodTotals.count === 1 ? '' : 's'} · newest first</p>
                {filtered.map(entry => {
                  // Mileage against the previous fill-up by odometer, not by list position.
                  const idx = allEntries.findIndex(e => e.id === entry.id);
                  const prev = allEntries[idx + 1];
                  const dist = prev ? entry.odometer - prev.odometer : null;
                  const mileage = dist && dist >0 && entry.full_tank ? (dist / entry.litres).toFixed(1) : null;
                  return (
                    <Card key={entry.id} className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center text-xl flex-shrink-0"></div>
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">{entry.litres} L · {formatCurrency(entry.amount)}</p>
                          <p className="text-muted text-xs">{formatDate(entry.date)} · {entry.odometer.toLocaleString()} km</p>
                          {entry.station && <p className="text-muted text-xs truncate">{entry.station}</p>}
                          {!entry.full_tank && <p className="text-muted text-xs italic">Partial fill</p>}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        {mileage && <p className="text-green-400 text-sm font-bold">{mileage} km/L</p>}
                        {entry.price_per_l != null && <p className="text-muted text-xs">₹{entry.price_per_l.toFixed(1)}/L</p>}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <Modal open={showAdd} onClose={closeForm} title="Add Fuel Entry">
        <div className="flex flex-col gap-3">
          <Select label="Bike *" value={form.motorcycle_id} onChange={e => setForm(f => ({ ...f, motorcycle_id: e.target.value }))}>
            <option value="">Select bike</option>
            {(bikes ?? []).map(b => <option key={b.id} value={b.id}>{b.brand} {b.model}</option>)}
          </Select>

          <div className="grid grid-cols-2 gap-3">
            <Input label="Date *" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            <Input label="Odometer (km) *" type="number" inputMode="numeric" placeholder="12345" value={form.odometer} onChange={e => setForm(f => ({ ...f, odometer: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Litres *" type="number" inputMode="decimal" step="0.01" placeholder="12.5" value={form.litres} onChange={e => setForm(f => ({ ...f, litres: e.target.value }))} />
            <Input label="Amount (₹) *" type="number" inputMode="decimal" placeholder="1250" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
          </div>

          {form.litres && form.amount && parseFloat(form.litres) >0 && (
            <p className="text-muted text-xs">That works out to ₹{(parseFloat(form.amount) / parseFloat(form.litres)).toFixed(2)} per litre.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input label="Station" placeholder="IOC Pump" value={form.station} onChange={e => setForm(f => ({ ...f, station: e.target.value }))} />
            <Select label="Fuel Type" value={form.fuel_type} onChange={e => setForm(f => ({ ...f, fuel_type: e.target.value }))}>
              {['Petrol', 'Diesel', 'CNG', 'Electric'].map(t => <option key={t}>{t}</option>)}
            </Select>
          </div>

          <label className="flex items-start gap-2 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={form.full_tank} onChange={e => setForm(f => ({ ...f, full_tank: e.target.checked }))} className="w-4 h-4 accent-accent mt-0.5" />
            <span>Full tank fill-up
              <span className="block text-xs">Only full tanks are used to calculate mileage.</span>
            </span>
          </label>

          {/* Ride attribution — offered only while a ride on this bike is under way */}
          {canAttach && (
            <label className="flex items-start gap-2 text-sm text-ink cursor-pointer bg-accent/10 border border-accent/30 rounded-xl p-3">
              <input type="checkbox" checked={attachToRide} onChange={e => setAttachToRide(e.target.checked)}
                     className="w-4 h-4 accent-accent mt-0.5" />
              <span>Count toward “{activeRide!.name}”
                <span className="block text-muted text-xs">Adds this fill-up to that ride's fuel cost and mileage. It still counts in your
                  bike's lifetime totals — logged once, counted in both.
                </span>
              </span>
            </label>
          )}

          {activeRide && !canAttach && (
            <p className="text-muted text-xs">
              “{activeRide.name}” is under way on a different bike, so this fill-up will not be
              added to it.
            </p>
          )}

          {error && <p className="text-danger text-sm">{error}</p>}

          <Button fullWidth loading={saving} onClick={handleSubmit}>Save Entry</Button>
        </div>
      </Modal>
    </div>
  );
}
