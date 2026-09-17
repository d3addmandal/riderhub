import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Motorcycle, ServiceRecord } from '../../types';
import { Button, Input, Select, Textarea, Modal } from '../ui';
import { formatCurrency } from '../../lib/utils';

const SERVICE_TYPES = ['General', 'Oil Change', 'Chain Service', 'Brake Service',
  'Tyre Change', 'Battery', 'Engine Work', 'Full Service', 'Other'];

interface ServiceForm {
  motorcycle_id: string; service_date: string; odometer: string;
  workshop: string; cost: string; service_type: string; notes: string;
  parts: { part_name: string; brand: string; cost: string; quantity: string }[];
}

const blank = (bikeId = ''): ServiceForm => ({
  motorcycle_id: bikeId,
  service_date: new Date().toISOString().split('T')[0],
  odometer: '', workshop: '', cost: '', service_type: 'General', notes: '', parts: [],
});

/** An existing record, turned back into something editable. */
function fromRecord(r: ServiceRecord): ServiceForm {
  const parts = r.service_parts ?? [];
  const partsTotal = parts.reduce((s, p) => s + (p.cost || 0), 0);
  return {
    motorcycle_id: r.motorcycle_id,
    service_date: (r.service_date ?? '').split('T')[0],
    odometer: String(r.odometer ?? ''),
    workshop: r.workshop ?? '',
    // Older records pre-date the itemised breakdown and only carry a total, so work
    // labour back out of it rather than showing the rider a blank they did not leave.
    cost: String((r as any).labour_cost ?? Math.max(0, (r.cost ?? 0) - partsTotal)),
    service_type: r.service_type || 'General',
    notes: r.notes ?? '',
    parts: parts.map(p => ({
      part_name: p.part_name ?? '',
      brand: p.brand ?? '',
      cost: String(p.cost ?? ''),
      quantity: String(p.quantity ?? 1),
    })),
  };
}

/**
 * Log a workshop visit, or correct one already logged.
 *
 * One form for both: a service record is mostly transcribed off an invoice, and
 * transcription goes wrong — a digit in the odometer, a part left off, the wrong bike.
 * Having to delete and re-enter the whole visit to fix a typo loses the service number
 * and the maintenance reset that came with it.
 *
 * Costs are deliberately not sent as a total. Labour and each part go up separately and
 * the server adds them, so the itemised figures and the total can never disagree.
 */
export default function ServiceFormModal({
  open, onClose, record, defaultBikeId,
}: {
  open: boolean;
  onClose: () => void;
  /** Editing an existing record; omit to log a new one. */
  record?: ServiceRecord | null;
  defaultBikeId?: string;
}) {
  const qc = useQueryClient();
  const editing = !!record;
  const [form, setForm] = useState<ServiceForm>(blank(defaultBikeId));
  const [error, setError] = useState('');

  const { data: bikes } = useQuery<Motorcycle[]>({
    queryKey: ['bikes'], queryFn: () => api.get('/bikes'), enabled: open,
  });

  // Reload the form each time the sheet opens, so a cancelled edit leaves nothing behind
  // and the next one starts from what is actually stored.
  useEffect(() => {
    if (!open) return;
    setForm(record ? fromRecord(record) : blank(defaultBikeId));
    setError('');
  }, [open, record?.id, defaultBikeId]);

  const save = useMutation({
    mutationFn: (data: any) => editing
      ? api.put(`/services/${record!.id}`, data)
      : api.post('/services', data),
    onSuccess: (saved: any) => {
      for (const key of [['services'], ['bikes'], ['maintenance'], ['bike-dashboard']]) {
        qc.invalidateQueries({ queryKey: key });
      }
      if (editing) qc.invalidateQueries({ queryKey: ['service', record!.id] });
      // Say what the service reset, so the rider trusts that it happened.
      const updated: string[] = saved?.maintenance_updated ?? [];
      if (updated.length) {
        alert(`Service saved.\n\nMaintenance updated automatically:\n• ${updated.join('\n• ')}`);
      }
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const setPart = (i: number, field: string, value: string) =>
    setForm(f => ({ ...f, parts: f.parts.map((p, idx) => idx === i ? { ...p, [field]: value } : p) }));

  function submit() {
    if (!form.motorcycle_id) { setError('Choose which bike was serviced.'); return; }
    if (!form.odometer) { setError('Enter the odometer reading at the time of service.'); return; }
    const odometer = parseInt(form.odometer, 10);
    if (!Number.isFinite(odometer) || odometer < 0) { setError('Odometer must be a positive number.'); return; }

    setError('');
    save.mutate({
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
    <Modal open={open} onClose={onClose} title={editing ? 'Edit Service Record' : 'Add Service Record'}>
      <div className="flex flex-col gap-3">
        {!!bikes?.length && (
          <Select label="Bike" value={form.motorcycle_id}
                  onChange={e => setForm(f => ({ ...f, motorcycle_id: e.target.value }))}>
            <option value="">Select bike</option>
            {bikes.map(b => <option key={b.id} value={b.id}>{b.brand} {b.model}</option>)}
          </Select>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Date" type="date" value={form.service_date}
                 onChange={e => setForm(f => ({ ...f, service_date: e.target.value }))} />
          <Input label="Odometer (km)" type="number" placeholder="12345" value={form.odometer}
                 onChange={e => setForm(f => ({ ...f, odometer: e.target.value }))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Service Type" value={form.service_type}
                  onChange={e => setForm(f => ({ ...f, service_type: e.target.value }))}>
            {SERVICE_TYPES.map(t => <option key={t}>{t}</option>)}
          </Select>
          <Input label="Labour Cost (₹)" type="number" placeholder="500" value={form.cost}
                 onChange={e => setForm(f => ({ ...f, cost: e.target.value }))} />
        </div>
        <Input label="Workshop" placeholder="ABC Auto Service" value={form.workshop}
               onChange={e => setForm(f => ({ ...f, workshop: e.target.value }))} />
        <Textarea label="Notes" placeholder="What was done…" rows={2} value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />

        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Parts Replaced</p>
          <Button size="sm" variant="ghost"
                  onClick={() => setForm(f => ({ ...f, parts: [...f.parts, { part_name: '', brand: '', cost: '', quantity: '1' }] }))}>
            + Add Part
          </Button>
        </div>
        {form.parts.map((part, i) => (
          <div key={i} className="flex flex-col gap-2 p-3 bg-surface2 rounded-xl">
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Part name" value={part.part_name} onChange={e => setPart(i, 'part_name', e.target.value)} />
              <Input placeholder="Brand" value={part.brand} onChange={e => setPart(i, 'brand', e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Input type="number" placeholder="Cost ₹" value={part.cost}
                     onChange={e => setPart(i, 'cost', e.target.value)} className="flex-1" />
              <Input type="number" placeholder="Qty" value={part.quantity}
                     onChange={e => setPart(i, 'quantity', e.target.value)} className="w-20" />
              <Button size="sm" variant="danger"
                      onClick={() => setForm(f => ({ ...f, parts: f.parts.filter((_, idx) => idx !== i) }))}>
                Remove
              </Button>
            </div>
          </div>
        ))}

        {/* Running total, so the rider sees the bill add up as they type */}
        <div className="bg-surface2 rounded-xl p-3 flex flex-col gap-1 text-sm">
          <div className="flex justify-between text-muted"><span>Labour</span>
            <span>{formatCurrency(parseFloat(form.cost) || 0)}</span></div>
          <div className="flex justify-between text-muted">
            <span>Parts ({form.parts.filter(p => p.part_name.trim()).length})</span>
            <span>{formatCurrency(partsTotal)}</span></div>
          <div className="flex justify-between text-ink font-semibold pt-1 border-t border-border">
            <span>Total</span><span>{formatCurrency(grandTotal)}</span>
          </div>
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        <Button fullWidth loading={save.isPending} onClick={submit}>
          {editing ? 'Save Changes' : 'Save Service'}
        </Button>
      </div>
    </Modal>
  );
}
