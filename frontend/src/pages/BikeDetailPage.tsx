import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { MaintenanceResponse, MaintenanceItem, BikeDashboard } from '../types';
import { Button, Card, Input, Select, Modal, Spinner, Empty, Badge } from '../components/ui';
import IssueLog from '../components/service/IssueLog';
import MaintenanceTile, { remainingText, STATUS_STYLE } from '../components/common/MaintenanceTile';
import { formatCurrency, formatDate } from '../lib/utils';

const EMPTY_CUSTOM = { name: '', category: 'Other', interval_km: '', interval_days: '' };

export default function BikeDetailPage() {
  const { bikeId } = useParams<{ bikeId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<MaintenanceItem | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [custom, setCustom] = useState(EMPTY_CUSTOM);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');

  const { data: maint, isLoading } = useQuery<MaintenanceResponse>({
    queryKey: ['maintenance', bikeId],
    queryFn: () => api.get(`/maintenance/bike/${bikeId}`),
    enabled: !!bikeId,
  });

  const { data: stats } = useQuery<BikeDashboard>({
    queryKey: ['bike-dashboard', bikeId, 'all'],
    queryFn: () => api.get(`/analytics/bike/${bikeId}?period=all`),
    enabled: !!bikeId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['maintenance'] });
    qc.invalidateQueries({ queryKey: ['bike-dashboard'] });
  };

  const markDone = useMutation({
    mutationFn: (vars: { id: string; odometer?: number; cost?: number }) => api.post(`/maintenance/${vars.id}/replaced`, { odometer: vars.odometer, cost: vars.cost }),
    onSuccess: () => { invalidate(); setSelected(null); },
    onError: (e: Error) => setError(e.message),
  });

  const addCustom = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/maintenance', body),
    onSuccess: () => { invalidate(); setShowAdd(false); setCustom(EMPTY_CUSTOM); setError(''); },
    onError: (e: Error) => setError(e.message),
  });

  const removeComponent = useMutation({
    mutationFn: (id: string) => api.delete(`/maintenance/${id}`),
    onSuccess: () => { invalidate(); setSelected(null); },
  });

  function submitCustom() {
    if (!custom.name.trim()) { setError('Give the component a name.'); return; }
    if (!custom.interval_km && !custom.interval_days) {
      setError('Set a distance interval, a time interval, or both.'); return;
    }
    setError('');
    addCustom.mutate({
      motorcycle_id: bikeId,
      name: custom.name.trim(),
      category: custom.category,
      interval_km: custom.interval_km ? parseInt(custom.interval_km, 10) : undefined,
      interval_days: custom.interval_days ? parseInt(custom.interval_days, 10) : undefined,
    });
  }

  if (isLoading) { return <div className="h-full flex items-center justify-center"><Spinner size="lg" /></div>;
  }

  if (!maint) {
    return (
      <div className="p-4">
        <Empty icon="🏍️" title="Bike not found" action={<Button onClick={() => navigate('/garage')}>Back to garage</Button>} />
      </div>
    );
  }

  const counts = maint.summary;
  const needsAttention = maint.components.filter(c => c.status !== 'healthy' && c.status !== 'unknown');
  const shown = filter === 'attention' && needsAttention.length ? needsAttention : maint.components;

  // Group by category so a long list stays navigable.
  const grouped = shown.reduce<Record<string, MaintenanceItem[]>>((acc, c) => {
    (acc[c.category] ||= []).push(c);
    return acc;
  }, {});

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-5 pb-6">

        {/* Overview (spec §6) */}
        <div>
          <h1 className="text-xl font-bold text-ink">{maint.bike.brand} {maint.bike.model}</h1>
          <p className="text-muted text-xs">{maint.bike.current_odometer.toLocaleString()} km on the clock</p>
        </div>

        {stats && (
          <div className="grid grid-cols-2 gap-3">
            <Card className="flex flex-col gap-0.5">
              <span className="text-muted text-[10px] uppercase tracking-wider">Total distance</span>
              <span className="text-lg font-black text-ink tabular-nums">{stats.distance.total.toLocaleString()} km</span>
            </Card>
            <Card className="flex flex-col gap-0.5">
              <span className="text-muted text-[10px] uppercase tracking-wider">Mileage</span>
              <span className="text-lg font-black text-green-400 tabular-nums">
                {stats.mileage.reliable && stats.mileage.value ? `${stats.mileage.value} km/L` : '—'}
              </span>
            </Card>
            <Card className="flex flex-col gap-0.5">
              <span className="text-muted text-[10px] uppercase tracking-wider">Fuel spend</span>
              <span className="text-lg font-black text-orange-400 tabular-nums">{formatCurrency(stats.costs.fuel)}</span>
            </Card>
            <Card className="flex flex-col gap-0.5">
              <span className="text-muted text-[10px] uppercase tracking-wider">Service spend</span>
              <span className="text-lg font-black text-blue-400 tabular-nums">{formatCurrency(stats.costs.service)}</span>
            </Card>
          </div>
        )}

        {/* What the rider has noticed, ahead of the scheduled clocks below: these are the
            things they will actually want to read out at the workshop counter. */}
        <IssueLog bikeId={bikeId!} />

        {/* Health summary */}
        <div className="flex gap-2 flex-wrap">
          {counts.overdue >0 && <Badge variant="danger">{counts.overdue} overdue</Badge>}
          {counts.due >0 && <Badge variant="warning">{counts.due} due</Badge>}
          {counts.due_soon >0 && <Badge variant="warning">{counts.due_soon} due soon</Badge>}
          <Badge variant="success">{counts.healthy} healthy</Badge>
        </div>

        {/* Maintenance */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-ink">Maintenance</h2>
            <Button size="sm" variant="ghost" onClick={() => { setError(''); setShowAdd(true); }}>+ Component</Button>
          </div>

          {needsAttention.length >0 && (
            <div className="flex gap-2">
              <button
                onClick={() => setFilter('attention')}
                className={`btn3d btn3d-accent flex-1 py-2 rounded-xl text-xs font-semibold border transition-colors ${filter === 'attention' ? 'bg-accent border-accent text-accent-ink' : 'bg-surface2 border-border text-muted'}`}
              >Needs attention ({needsAttention.length})
              </button>
              <button
                onClick={() => setFilter('all')}
                className={`btn3d btn3d-accent flex-1 py-2 rounded-xl text-xs font-semibold border transition-colors ${filter === 'all' ? 'bg-accent border-accent text-accent-ink' : 'bg-surface2 border-border text-muted'}`}
              >All ({maint.components.length})
              </button>
            </div>
          )}

          {Object.entries(grouped).map(([category, items]) => (
            <div key={category} className="flex flex-col gap-2">
              <p className="text-muted text-[10px] uppercase tracking-wider mt-1">{category}</p>
              {items.map(item => (
                <MaintenanceTile key={item.id} item={item} onClick={() => { setError(''); setSelected(item); }} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Component detail */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.name ?? ''}>
        {selected && (
          <div className="flex flex-col gap-4">
            <div className={`rounded-xl border p-3 ${STATUS_STYLE[selected.status].box}`}>
              <p className={`font-bold text-sm ${STATUS_STYLE[selected.status].text}`}>{selected.status_label}</p>
              <p className={`text-xs ${STATUS_STYLE[selected.status].text}`}>{remainingText(selected)}</p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted text-[11px]">Last changed</p>
                <p className="text-ink">
                  {selected.last_changed_km != null ? `${selected.last_changed_km.toLocaleString()} km` : '—'}
                </p>
                {selected.last_changed_date && (
                  <p className="text-muted text-[11px]">{formatDate(selected.last_changed_date)}</p>
                )}
              </div>
              <div>
                <p className="text-muted text-[11px]">Next due</p>
                <p className="text-ink">
                  {selected.next_due_km != null ? `${selected.next_due_km.toLocaleString()} km` : '—'}
                </p>
                {selected.next_due_date && (
                  <p className="text-muted text-[11px]">{formatDate(selected.next_due_date)}</p>
                )}
              </div>
              <div>
                <p className="text-muted text-[11px]">Interval</p>
                <p className="text-ink">
                  {[selected.interval_km ? `${selected.interval_km.toLocaleString()} km` : null,
                    selected.interval_days ? `${selected.interval_days} days` : null]
                    .filter(Boolean).join(' / ') || '—'}
                </p>
              </div>
              <div>
                <p className="text-muted text-[11px]">Driven by</p>
                <p className="text-ink capitalize">{selected.driver ?? '—'}</p>
              </div>
            </div>

            {selected.last_cost != null && (
              <p className="text-muted text-xs">Last cost {formatCurrency(selected.last_cost)}</p>
            )}

            {error && <p className="text-danger text-sm">{error}</p>}

            <Button
              fullWidth
              loading={markDone.isPending}
              onClick={() => markDone.mutate({ id: selected.id, odometer: maint.bike.current_odometer })}
            >Mark replaced at {maint.bike.current_odometer.toLocaleString()} km
            </Button>

            {selected.component_key === null && (
              <Button
                fullWidth
                variant="danger"
                onClick={() => { if (confirm(`Remove "${selected.name}" from tracking?`)) removeComponent.mutate(selected.id); }}
              >Remove component
              </Button>
            )}
          </div>
        )}
      </Modal>

      {/* Custom component */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Track a Component">
        <div className="flex flex-col gap-3">
          <Input label="Component name" placeholder="Crash guard bolts" value={custom.name}
                 onChange={e => setCustom(c => ({ ...c, name: e.target.value }))} />
          <Select label="Category" value={custom.category} onChange={e => setCustom(c => ({ ...c, category: e.target.value }))}>
            {['Engine', 'Cooling', 'Brakes', 'Drivetrain', 'Tyres', 'Suspension', 'Electrical', 'Controls', 'Chassis', 'Other']
              .map(c => <option key={c}>{c}</option>)}
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Every (km)" type="number" inputMode="numeric" placeholder="5000" value={custom.interval_km}
                   onChange={e => setCustom(c => ({ ...c, interval_km: e.target.value }))} />
            <Input label="Every (days)" type="number" inputMode="numeric" placeholder="180" value={custom.interval_days}
                   onChange={e => setCustom(c => ({ ...c, interval_days: e.target.value }))} />
          </div>
          <p className="text-muted text-xs">Set either or both. With both, whichever comes first makes it due.
          </p>
          {error && <p className="text-danger text-sm">{error}</p>}
          <Button fullWidth loading={addCustom.isPending} onClick={submitCustom}>Add Component</Button>
        </div>
      </Modal>
    </div>
  );
}
