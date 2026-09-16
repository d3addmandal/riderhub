import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Motorcycle, BikeDashboard } from '../types';
import { Button, Card, Input, Spinner, Empty, Modal, Badge } from '../components/ui';
import { useNavigate } from 'react-router-dom';

/**
 * One motorcycle at a glance (spec §5.1): odometer, real mileage, last and next service,
 * and overall maintenance health. Each card pulls its own summary so a rider with six
 * bikes does not wait on one giant request.
 */
function BikeCard({ bike, onOpen, onEdit, onDelete, onFuel, onService }: {
  bike: Motorcycle;
  onOpen: () => void; onEdit: () => void; onDelete: () => void;
  onFuel: () => void; onService: () => void;
}) {
  const { data } = useQuery<BikeDashboard>({
    queryKey: ['bike-dashboard', bike.id, 'all'],
    queryFn: () => api.get(`/analytics/bike/${bike.id}?period=all`),
  });

  const counts = data?.maintenance.counts;
  const health = !counts ? null
    : counts.overdue >0 ? { label: `${counts.overdue} overdue`, variant: 'danger' as const }
    : counts.due >0 ? { label: `${counts.due} due`, variant: 'warning' as const }
    : counts.due_soon >0 ? { label: `${counts.due_soon} due soon`, variant: 'warning' as const }
    : { label: 'Good', variant: 'success' as const };

  return (
    <Card className="flex flex-col gap-3">
      <button onClick={onOpen} className="flex items-start gap-3 text-left w-full">
        <div className="w-12 h-12 rounded-xl bg-surface2 flex items-center justify-center text-2xl flex-shrink-0">🏍️</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-bold text-ink truncate">{bike.brand} {bike.model}</p>
            {bike.is_primary && <Badge variant="success">Primary</Badge>}
          </div>
          {bike.variant && <p className="text-muted text-xs">{bike.variant}</p>}
          <p className="text-muted text-xs">
            {bike.year ? `${bike.year} · ` : ''}
            {bike.registration_no ?? 'No registration'}
          </p>
        </div>
        {health && <Badge variant={health.variant}>{health.label}</Badge>}
      </button>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-surface2 rounded-xl p-2">
          <p className="text-[10px] text-muted uppercase tracking-wide">Odometer</p>
          <p className="text-sm font-bold text-ink tabular-nums">{bike.current_odometer.toLocaleString()}</p>
          <p className="text-[10px] text-muted">km</p>
        </div>
        <div className="bg-surface2 rounded-xl p-2">
          <p className="text-[10px] text-muted uppercase tracking-wide">Mileage</p>
          <p className="text-sm font-bold text-green-400 tabular-nums">
            {data?.mileage.reliable && data.mileage.value ? data.mileage.value : '—'}
          </p>
          <p className="text-[10px] text-muted">km/L</p>
        </div>
        <div className="bg-surface2 rounded-xl p-2">
          <p className="text-[10px] text-muted uppercase tracking-wide">Next service</p>
          <p className="text-sm font-bold text-ink tabular-nums">
            {data?.next_service?.km_remaining != null
              ? (data.next_service.km_remaining < 0
                  ? `+${Math.abs(data.next_service.km_remaining).toLocaleString()}`
                  : data.next_service.km_remaining.toLocaleString())
              : '—'}
          </p>
          <p className="text-[10px] text-muted">
            {data?.next_service?.km_remaining != null && data.next_service.km_remaining < 0 ? 'km over' : 'km'}
          </p>
        </div>
      </div>

      {data?.last_service && (
        <p className="text-muted text-[11px]">Last service {new Date(data.last_service.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          {' · '}{data.last_service.odometer.toLocaleString()} km
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1" onClick={onFuel}>Fuel</Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={onService}>Service</Button>
        <Button size="sm" variant="outline" onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="danger" onClick={onDelete}>Del</Button>
      </div>
    </Card>
  );
}

interface BikeForm {
  brand: string; model: string; variant: string; year: string;
  registration_no: string; current_odometer: string; fuel_capacity: string;
  engine_oil_type: string; tyre_size: string; color: string;
}

const EMPTY_FORM: BikeForm = { brand: '', model: '', variant: '', year: '', registration_no: '', current_odometer: '0', fuel_capacity: '', engine_oil_type: '', tyre_size: '', color: '' };

export default function GaragePage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<BikeForm>(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null);
  const navigate = useNavigate();

  const { data: bikes, isLoading } = useQuery<Motorcycle[]>({
    queryKey: ['bikes'],
    queryFn: () => api.get('/bikes'),
  });

  const save = useMutation({
    mutationFn: (data: Partial<Motorcycle>) => editId ? api.put(`/bikes/${editId}`, data) : api.post('/bikes', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bikes'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); setShowAdd(false); setEditId(null); setForm(EMPTY_FORM); },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/bikes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bikes'] });
      qc.invalidateQueries({ queryKey: ['bike-dashboard'] });
      qc.invalidateQueries({ queryKey: ['maintenance'] });
    },
  });

  /**
   * Deleting a bike now takes its fuel, service, maintenance and reminder history with it,
   * so the confirmation spells that out rather than asking a vague "are you sure?".
   */
  function confirmDelete(bike: Motorcycle) {
    const ok = confirm(
      `Delete ${bike.brand} ${bike.model}?\n\n` +
      `This also permanently deletes its fuel entries, service records, maintenance ` +
      `tracking and reminders. Documents are kept but unlinked.\n\nThis cannot be undone.`
    );
    if (ok) del.mutate(bike.id);
  }

  function openEdit(bike: Motorcycle) {
    setForm({ brand: bike.brand, model: bike.model, variant: bike.variant || '', year: bike.year?.toString() || '', registration_no: bike.registration_no || '', current_odometer: bike.current_odometer.toString(), fuel_capacity: bike.fuel_capacity?.toString() || '', engine_oil_type: bike.engine_oil_type || '', tyre_size: bike.tyre_size || '', color: bike.color || '' });
    setEditId(bike.id);
    setShowAdd(true);
  }

  function handleSubmit() {
    if (!form.brand || !form.model) return;
    save.mutate({
      brand: form.brand, model: form.model, variant: form.variant || undefined,
      year: form.year ? parseInt(form.year) : undefined,
      registration_no: form.registration_no || undefined,
      current_odometer: parseInt(form.current_odometer) || 0,
      fuel_capacity: form.fuel_capacity ? parseFloat(form.fuel_capacity) : undefined,
      engine_oil_type: form.engine_oil_type || undefined,
      tyre_size: form.tyre_size || undefined,
      color: form.color || undefined,
    });
  }

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between pt-2">
          <h1 className="text-xl font-bold text-ink">My Garage</h1>
          <Button size="sm" onClick={() => { setForm(EMPTY_FORM); setEditId(null); setShowAdd(true); }}>+ Add Bike</Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : !bikes?.length ? (
          <Empty icon="🏍️" title="No bikes yet" desc="Add your motorcycle to get started" action={<Button onClick={() => setShowAdd(true)}>Add Your First Bike</Button>} />
        ) : (
          <div className="flex flex-col gap-3">
            {bikes.map(bike => <BikeCard
              key={bike.id}
              bike={bike}
              onOpen={() => navigate(`/garage/${bike.id}`)}
              onEdit={() => openEdit(bike)}
              onDelete={() => confirmDelete(bike)}
              onFuel={() => navigate(`/fuel?bike=${bike.id}`)}
              onService={() => navigate(`/service?bike=${bike.id}`)}
            />)}
          </div>
        )}
      </div>

      <Modal open={showAdd} onClose={() => { setShowAdd(false); setEditId(null); }} title={editId ? 'Edit Bike' : 'Add Bike'}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Brand *" placeholder="Honda" value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} />
            <Input label="Model *" placeholder="CB350" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
          </div>
          <Input label="Variant" placeholder="Deluxe" value={form.variant} onChange={e => setForm(f => ({ ...f, variant: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Year" type="number" placeholder="2022" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
            <Input label="Reg. Number" placeholder="MH01XX1234" value={form.registration_no} onChange={e => setForm(f => ({ ...f, registration_no: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Odometer (km)" type="number" value={form.current_odometer} onChange={e => setForm(f => ({ ...f, current_odometer: e.target.value }))} />
            <Input label="Tank Capacity (L)" type="number" placeholder="15" value={form.fuel_capacity} onChange={e => setForm(f => ({ ...f, fuel_capacity: e.target.value }))} />
          </div>
          <Input label="Engine Oil Type" placeholder="10W-30" value={form.engine_oil_type} onChange={e => setForm(f => ({ ...f, engine_oil_type: e.target.value }))} />
          <Input label="Tyre Size" placeholder="100/80-17" value={form.tyre_size} onChange={e => setForm(f => ({ ...f, tyre_size: e.target.value }))} />
          <Button fullWidth loading={save.isPending} onClick={handleSubmit}>{editId ? 'Save Changes' : 'Add Bike'}</Button>
        </div>
      </Modal>
    </div>
  );
}
