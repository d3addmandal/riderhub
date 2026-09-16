import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ServiceRecord, ServicePart, Motorcycle } from '../types';
import { Button, Card, Input, Select, Textarea, Modal, Spinner, Empty } from '../components/ui';
import { formatCurrency, formatDate } from '../lib/utils';

interface ServiceForm {
  motorcycle_id: string; service_date: string; odometer: string;
  workshop: string; cost: string; service_type: string; notes: string;
  parts: { part_name: string; brand: string; cost: string; quantity: string }[];
}

const SERVICE_TYPES = ['General', 'Oil Change', 'Chain Service', 'Brake Service', 'Tyre Change', 'Battery', 'Engine Work', 'Full Service', 'Other'];

export default function ServicePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState<ServiceForm>({ motorcycle_id: params.get('bike') || '', service_date: today, odometer: '', workshop: '', cost: '', service_type: 'General', notes: '', parts: [] });

  const { data: bikes } = useQuery<Motorcycle[]>({ queryKey: ['bikes'], queryFn: () => api.get('/bikes') });

  const { data: records, isLoading } = useQuery<ServiceRecord[]>({
    queryKey: ['services'],
    queryFn: () => api.get('/services'),
  });

  const [error, setError] = useState('');

  const add = useMutation({
    mutationFn: (data: any) => api.post('/services', data),
    onSuccess: (saved: any) => {
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['bikes'] });
      qc.invalidateQueries({ queryKey: ['maintenance'] });
      qc.invalidateQueries({ queryKey: ['bike-dashboard'] });
      // Tell the rider what the service reset, so they trust it happened.
      const updated: string[] = saved?.maintenance_updated ?? [];
      if (updated.length) {
        alert(`Service saved.\n\nMaintenance updated automatically:\n• ${updated.join('\n• ')}`);
      }
      setShowAdd(false);
      setError('');
    },
    onError: (e: Error) => setError(e.message),
  });

  function addPart() {
    setForm(f => ({ ...f, parts: [...f.parts, { part_name: '', brand: '', cost: '', quantity: '1' }] }));
  }

  function updatePart(i: number, field: string, value: string) {
    setForm(f => ({ ...f, parts: f.parts.map((p, idx) => idx === i ? { ...p, [field]: value } : p) }));
  }

  function removePart(i: number) {
    setForm(f => ({ ...f, parts: f.parts.filter((_, idx) => idx !== i) }));
  }

  function handleSubmit() {
    if (!form.motorcycle_id) { setError('Choose which bike was serviced.'); return; }
    if (!form.odometer)      { setError('Enter the odometer reading at the time of service.'); return; }

    const odometer = parseInt(form.odometer, 10);
    if (!Number.isFinite(odometer) || odometer < 0) { setError('Odometer must be a positive number.'); return; }

    setError('');
    // Send labour on its own — the server adds the parts, tax and other charges, so the
    // itemised figures and the total can never drift apart.
    add.mutate({
      motorcycle_id: form.motorcycle_id,
      service_date: form.service_date,
      odometer,
      workshop: form.workshop || undefined,
      labour_cost: parseFloat(form.cost) || 0,
      service_type: form.service_type,
      notes: form.notes || undefined,
      parts: form.parts
        .filter(p => p.part_name.trim())
        .map(p => ({
          part_name: p.part_name.trim(),
          brand: p.brand || undefined,
          cost: parseFloat(p.cost) || 0,
          quantity: parseInt(p.quantity, 10) || 1,
        })),
    });
  }

  const partsTotal = form.parts.reduce((s, p) => s + (parseFloat(p.cost) || 0), 0);
  const grandTotal = (parseFloat(form.cost) || 0) + partsTotal;

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between pt-2">
          <h1 className="text-xl font-bold text-ink">Service History</h1>
          <Button size="sm" onClick={() => setShowAdd(true)}>+ Add</Button>
        </div>

        {/* Summary strip */}
        {!!records?.length && (
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-surface border border-border rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-muted uppercase tracking-wide">Services</p>
              <p className="text-base font-bold text-ink tabular-nums">{records.length}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-muted uppercase tracking-wide">Total spend</p>
              <p className="text-base font-bold text-blue-400 tabular-nums">
                {formatCurrency(records.reduce((s, r) => s + (r.cost || 0), 0))}
              </p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-2.5 text-center">
              <p className="text-[10px] text-muted uppercase tracking-wide">Average</p>
              <p className="text-base font-bold text-ink tabular-nums">
                {formatCurrency(Math.round(records.reduce((s, r) => s + (r.cost || 0), 0) / records.length))}
              </p>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map(i => <div key={i} className="h-16 rounded-2xl bg-surface animate-pulse" />)}
          </div>
        ) : !records?.length ? (
          <Empty title="No service records yet"
            desc="Log every workshop visit — it keeps your maintenance clocks accurate and builds a service history for resale." action={<Button onClick={() => setShowAdd(true)}>Add Service</Button>} />
        ) : (
          /* Service dashboard (spec §8.1): SL, number, date, odometer, centre, cost */
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[28px_1fr_auto] gap-3 px-3 text-[10px] uppercase tracking-wider text-muted">
              <span>SL</span><span>Service</span><span>Cost</span>
            </div>
            {records.map((record, i) => (
              <Card
                key={record.id}
                className="grid grid-cols-[28px_1fr_auto] gap-3 items-center py-3"
                onClick={() => navigate(`/service/${record.id}`)}
              >
                <span className="text-muted text-xs tabular-nums">{records.length - i}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-ink text-sm truncate">{record.service_type || 'Service'}</p>
                    {(record as any).service_number && (
                      <span className="text-[10px] text-muted font-mono">#{(record as any).service_number}</span>
                    )}
                  </div>
                  <p className="text-muted text-xs">
                    {formatDate(record.service_date)} · {record.odometer.toLocaleString()} km
                  </p>
                  <p className="text-muted text-xs truncate">
                    {record.workshop || 'Centre not recorded'}
                    {record.service_parts?.length ? ` · ${record.service_parts.length} parts` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-ink font-bold text-sm tabular-nums">{formatCurrency(record.cost)}</p>
                  <p className="text-muted text-[10px]">View →</p>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Service Record">
        <div className="flex flex-col gap-3">
          {bikes && bikes.length >0 && (
            <Select label="Bike" value={form.motorcycle_id} onChange={e => setForm(f => ({ ...f, motorcycle_id: e.target.value }))}>
              <option value="">Select bike</option>
              {bikes.map(b => <option key={b.id} value={b.id}>{b.brand} {b.model}</option>)}
            </Select>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Date" type="date" value={form.service_date} onChange={e => setForm(f => ({ ...f, service_date: e.target.value }))} />
            <Input label="Odometer (km)" type="number" placeholder="12345" value={form.odometer} onChange={e => setForm(f => ({ ...f, odometer: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Service Type" value={form.service_type} onChange={e => setForm(f => ({ ...f, service_type: e.target.value }))}>
              {SERVICE_TYPES.map(t => <option key={t}>{t}</option>)}
            </Select>
            <Input label="Labour Cost (₹)" type="number" placeholder="500" value={form.cost} onChange={e => setForm(f => ({ ...f, cost: e.target.value }))} />
          </div>
          <Input label="Workshop" placeholder="ABC Auto Service" value={form.workshop} onChange={e => setForm(f => ({ ...f, workshop: e.target.value }))} />
          <Textarea label="Notes" placeholder="What was done…" rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />

          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">Parts Replaced</p>
            <Button size="sm" variant="ghost" onClick={addPart}>+ Add Part</Button>
          </div>
          {form.parts.map((part, i) => (
            <div key={i} className="flex flex-col gap-2 p-3 bg-surface2 rounded-xl">
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Part name" value={part.part_name} onChange={e => updatePart(i, 'part_name', e.target.value)} />
                <Input placeholder="Brand" value={part.brand} onChange={e => updatePart(i, 'brand', e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Input type="number" placeholder="Cost ₹" value={part.cost} onChange={e => updatePart(i, 'cost', e.target.value)} className="flex-1" />
                <Input type="number" placeholder="Qty" value={part.quantity} onChange={e => updatePart(i, 'quantity', e.target.value)} className="w-20" />
                <Button size="sm" variant="danger" onClick={() => removePart(i)}></Button>
              </div>
            </div>
          ))}
          {/* Running total, so the rider sees the bill add up as they type */}
          <div className="bg-surface2 rounded-xl p-3 flex flex-col gap-1 text-sm">
            <div className="flex justify-between text-muted"><span>Labour</span><span>{formatCurrency(parseFloat(form.cost) || 0)}</span></div>
            <div className="flex justify-between text-muted"><span>Parts ({form.parts.filter(p => p.part_name.trim()).length})</span><span>{formatCurrency(partsTotal)}</span></div>
            <div className="flex justify-between text-ink font-semibold pt-1 border-t border-border">
              <span>Total</span><span>{formatCurrency(grandTotal)}</span>
            </div>
          </div>

          {error && <p className="text-danger text-sm">{error}</p>}

          <Button fullWidth loading={add.isPending} onClick={handleSubmit}>Save Service</Button>
        </div>
      </Modal>
    </div>
  );
}
