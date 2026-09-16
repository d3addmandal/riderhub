import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Reminder, Motorcycle } from '../types';
import { Button, Card, Input, Select, Modal, Spinner, Empty, Badge } from '../components/ui';
import { formatDate } from '../lib/utils';

const REMINDER_TYPES = ['Oil Change', 'Chain Cleaning', 'Chain Lubrication', 'Air Filter', 'Spark Plug', 'Brake Pad', 'Tyre Replacement', 'Battery Check', 'Insurance Renewal', 'PUC Renewal', 'Full Service', 'Other'];

const DEFAULTS: Record<string, { interval_km?: number; interval_days?: number; trigger_type: 'distance' | 'date' }> = {
  'Oil Change': { trigger_type: 'distance', interval_km: 5000 },
  'Chain Cleaning': { trigger_type: 'distance', interval_km: 500 },
  'Chain Lubrication': { trigger_type: 'distance', interval_km: 1000 },
  'Air Filter': { trigger_type: 'distance', interval_km: 10000 },
  'Spark Plug': { trigger_type: 'distance', interval_km: 10000 },
  'Insurance Renewal': { trigger_type: 'date', interval_days: 365 },
  'PUC Renewal': { trigger_type: 'date', interval_days: 180 },
  'Battery Check': { trigger_type: 'distance', interval_km: 20000 },
};

interface ReminderForm {
  motorcycle_id: string; reminder_type: string; trigger_type: 'distance' | 'date';
  interval_km: string; trigger_date: string; last_done_km: string; notify_telegram: boolean;
}

export default function RemindersPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<ReminderForm>({ motorcycle_id: '', reminder_type: 'Oil Change', trigger_type: 'distance', interval_km: '5000', trigger_date: '', last_done_km: '', notify_telegram: true });

  const { data: bikes } = useQuery<Motorcycle[]>({ queryKey: ['bikes'], queryFn: () => api.get('/bikes') });
  const { data: reminders, isLoading } = useQuery<Reminder[]>({ queryKey: ['reminders'], queryFn: () => api.get('/reminders') });

  const add = useMutation({
    mutationFn: (data: any) => api.post('/reminders', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reminders'] }); setShowAdd(false); },
  });

  const markDone = useMutation({
    mutationFn: ({ id, odometer }: { id: string; odometer?: number }) => api.patch(`/reminders/${id}/done`, { odometer }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reminders'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/reminders/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reminders'] }),
  });

  function handleTypeChange(type: string) {
    const def = DEFAULTS[type];
    setForm(f => ({
      ...f,
      reminder_type: type,
      trigger_type: def?.trigger_type || 'distance',
      interval_km: def?.interval_km?.toString() || '',
    }));
  }

  function handleSubmit() {
    if (!form.motorcycle_id) return;
    add.mutate({
      motorcycle_id: form.motorcycle_id,
      reminder_type: form.reminder_type,
      trigger_type: form.trigger_type,
      interval_km: form.trigger_type === 'distance' && form.interval_km ? parseInt(form.interval_km) : undefined,
      trigger_km: form.trigger_type === 'distance' && form.last_done_km && form.interval_km
        ? parseInt(form.last_done_km) + parseInt(form.interval_km) : undefined,
      trigger_date: form.trigger_type === 'date' ? form.trigger_date : undefined,
      last_done_km: form.last_done_km ? parseInt(form.last_done_km) : undefined,
      notify_telegram: form.notify_telegram,
    });
  }

  const dueReminders = (reminders || []).filter(r => r.isDue);
  const upcomingReminders = (reminders || []).filter(r => !r.isDue);

  function reminderBadge(r: Reminder) { if (r.isDue) return <Badge variant="danger">Due Now</Badge>;
    if (r.trigger_type === 'distance' && r.kmRemaining != null) { if (r.kmRemaining <= 500) return <Badge variant="warning">{r.kmRemaining.toLocaleString()} km left</Badge>; return <Badge variant="success">{r.kmRemaining.toLocaleString()} km left</Badge>;
    }
    if (r.daysRemaining != null) { if (r.daysRemaining <= 30) return <Badge variant="warning">{r.daysRemaining}d left</Badge>; return <Badge variant="success">{r.daysRemaining}d left</Badge>;
    }
    return null;
  }

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between pt-2">
          <h1 className="text-xl font-bold text-ink">Reminders</h1>
          <Button size="sm" onClick={() => setShowAdd(true)}>+ Add</Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : !reminders?.length ? (
          <Empty title="No reminders set" desc="Get notified when your bike needs servicing" action={<Button onClick={() => setShowAdd(true)}>Set Reminder</Button>} />
        ) : (
          <>
            {dueReminders.length >0 && (
              <div>
                <h2 className="text-ink font-semibold mb-3">Due Now ({dueReminders.length})</h2>
                <div className="flex flex-col gap-2">
                  {dueReminders.map(r => (
                    <Card key={r.id} className="flex items-center justify-between gap-3 border-danger/30">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-ink">{r.reminder_type}</p>
                          {reminderBadge(r)}
                        </div>
                        <p className="text-muted text-xs">{r.motorcycles?.brand} {r.motorcycles?.model}</p>
                      </div>
                      <Button size="sm" variant="secondary" onClick={() => markDone.mutate({ id: r.id, odometer: r.motorcycles?.current_odometer })}>Done </Button>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {upcomingReminders.length >0 && (
              <div>
                <h2 className="text-ink font-semibold mb-3">Upcoming</h2>
                <div className="flex flex-col gap-2">
                  {upcomingReminders.map(r => (
                    <Card key={r.id} className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-ink">{r.reminder_type}</p>
                          {reminderBadge(r)}
                        </div>
                        <p className="text-muted text-xs">{r.motorcycles?.brand} {r.motorcycles?.model}</p>
                        {r.trigger_type === 'distance' && r.interval_km && <p className="text-muted text-xs">Every {r.interval_km.toLocaleString()} km</p>}
                        {r.trigger_type === 'date' && r.trigger_date && <p className="text-muted text-xs">Due {formatDate(r.trigger_date)}</p>}
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => markDone.mutate({ id: r.id })}></Button>
                        <Button size="sm" variant="danger" onClick={() => remove.mutate(r.id)}></Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Reminder">
        <div className="flex flex-col gap-3">
          {bikes && bikes.length >0 ? (
            <Select label="Bike" value={form.motorcycle_id} onChange={e => setForm(f => ({ ...f, motorcycle_id: e.target.value }))}>
              <option value="">Select bike</option>
              {bikes.map(b => <option key={b.id} value={b.id}>{b.brand} {b.model}</option>)}
            </Select>
          ) : <p className="text-muted text-sm">Add a bike first</p>}

          <Select label="Reminder Type" value={form.reminder_type} onChange={e => handleTypeChange(e.target.value)}>
            {REMINDER_TYPES.map(t => <option key={t}>{t}</option>)}
          </Select>

          <div className="flex gap-3">
            {(['distance', 'date'] as const).map(t => (
              <button key={t} onClick={() => setForm(f => ({ ...f, trigger_type: t }))} className={`btn3d btn3d-accent flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${form.trigger_type === t ? 'bg-accent border-accent text-accent-ink' : 'bg-surface2 border-border text-muted'}`}>
                {t === 'distance' ? ' Distance' : ' Date'}
              </button>
            ))}
          </div>

          {form.trigger_type === 'distance' ? (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Every (km)" type="number" placeholder="5000" value={form.interval_km} onChange={e => setForm(f => ({ ...f, interval_km: e.target.value }))} />
              <Input label="Last done at (km)" type="number" placeholder="Current odometer" value={form.last_done_km} onChange={e => setForm(f => ({ ...f, last_done_km: e.target.value }))} />
            </div>
          ) : (
            <Input label="Due Date" type="date" value={form.trigger_date} onChange={e => setForm(f => ({ ...f, trigger_date: e.target.value }))} />
          )}

          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={form.notify_telegram} onChange={e => setForm(f => ({ ...f, notify_telegram: e.target.checked }))} className="w-4 h-4 accent-accent" />
            Notify via Telegram
          </label>

          <Button fullWidth loading={add.isPending} onClick={handleSubmit} disabled={!form.motorcycle_id}>Save Reminder</Button>
        </div>
      </Modal>
    </div>
  );
}
