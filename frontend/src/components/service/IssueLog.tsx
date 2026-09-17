import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Issue } from '../../types';
import { Button, Card, Input, Select, Textarea, Modal, Badge } from '../ui';
import { formatDate } from '../../lib/utils';

const SEVERITY: Record<Issue['severity'], { label: string; hint: string; variant: 'info' | 'warning' | 'danger' }> = {
  watch:  { label: 'Keep an eye on it', hint: 'Noted, no hurry',              variant: 'info' },
  soon:   { label: 'Next service',      hint: 'Get it seen at the next one',  variant: 'warning' },
  urgent: { label: 'Urgent',            hint: 'Affects riding now',           variant: 'danger' },
};

/**
 * The rider's running list of things wrong with the bike.
 *
 * A problem gets noticed mid-ride — a rattle, a lever coming to the bar — and weeks later
 * at the workshop counter it has been forgotten, or half-remembered as "something about
 * the front". Written down here it survives the gap, and when the bike is serviced the
 * service form offers these notes to tick off, so each one ends up recorded against the
 * visit that dealt with it.
 */
export default function IssueLog({ bikeId }: { bikeId: string }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [showFixed, setShowFixed] = useState(false);
  const [form, setForm] = useState({ title: '', details: '', severity: 'soon' as Issue['severity'] });
  const [error, setError] = useState('');

  const { data: issues } = useQuery<Issue[]>({
    queryKey: ['issues', bikeId],
    queryFn: () => api.get(`/issues?motorcycle_id=${bikeId}`),
    enabled: !!bikeId,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['issues', bikeId] });
    qc.invalidateQueries({ queryKey: ['issues'] });
  };

  const add = useMutation({
    mutationFn: () => api.post('/issues', {
      motorcycle_id: bikeId,
      title: form.title.trim(),
      details: form.details.trim() || undefined,
      severity: form.severity,
    }),
    onSuccess: () => {
      refresh();
      setForm({ title: '', details: '', severity: 'soon' });
      setShowAdd(false);
      setError('');
    },
    onError: (e: Error) => setError(e.message),
  });

  const fix = useMutation({
    mutationFn: (id: string) => api.post(`/issues/${id}/fix`, {}),
    onSuccess: refresh,
  });
  const reopen = useMutation({
    mutationFn: (id: string) => api.post(`/issues/${id}/reopen`, {}),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/issues/${id}`),
    onSuccess: refresh,
  });

  const open = (issues ?? []).filter(i => i.status === 'open');
  const fixed = (issues ?? []).filter(i => i.status === 'fixed');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-muted text-[10px] uppercase tracking-wider">
          Noticed issues{open.length ? ` · ${open.length} open` : ''}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setShowAdd(true)}>+ Note an issue</Button>
      </div>

      {!open.length && (
        <Card>
          <p className="text-muted text-sm">
            Nothing noted. When something sounds or feels wrong, put it here — it will be
            waiting when the bike next goes in.
          </p>
        </Card>
      )}

      {open.map(issue => (
        <Card key={issue.id} className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-ink text-sm font-medium">{issue.title}</p>
              {issue.details && <p className="text-muted text-xs whitespace-pre-wrap mt-0.5">{issue.details}</p>}
              <p className="text-muted text-[11px] mt-1">
                Noted {formatDate(issue.noted_at)}
                {issue.noted_odometer != null ? ` · ${issue.noted_odometer.toLocaleString()} km` : ''}
              </p>
            </div>
            <Badge variant={SEVERITY[issue.severity].variant}>{SEVERITY[issue.severity].label}</Badge>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" loading={fix.isPending && fix.variables === issue.id}
                    onClick={() => fix.mutate(issue.id)}>
              Mark fixed
            </Button>
            <Button size="sm" variant="ghost"
                    onClick={() => { if (confirm(`Delete "${issue.title}"?`)) remove.mutate(issue.id); }}>
              Delete
            </Button>
          </div>
        </Card>
      ))}

      {!!fixed.length && (
        <>
          <button className="text-muted text-xs underline self-start" onClick={() => setShowFixed(v => !v)}>
            {showFixed ? 'Hide' : `Show ${fixed.length} fixed`}
          </button>
          {showFixed && fixed.map(issue => (
            <Card key={issue.id} className="flex items-start justify-between gap-3 opacity-70">
              <div className="min-w-0">
                <p className="text-ink text-sm line-through">{issue.title}</p>
                <p className="text-muted text-[11px]">
                  Fixed {issue.fixed_at ? formatDate(issue.fixed_at) : ''}
                  {issue.fixed_by_service_id ? ' during a service' : ''}
                  {issue.fix_notes ? ` · ${issue.fix_notes}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => reopen.mutate(issue.id)}>Reopen</Button>
            </Card>
          ))}
        </>
      )}

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Note an issue">
        <div className="flex flex-col gap-3">
          <Input label="What is wrong?" placeholder="Chain noise at low revs"
                 value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          <Textarea label="Any detail worth telling the mechanic" rows={3}
                    placeholder="When it happens, what it sounds like, whether it comes and goes…"
                    value={form.details} onChange={e => setForm(f => ({ ...f, details: e.target.value }))} />
          <Select label="How urgent is it?" value={form.severity}
                  onChange={e => setForm(f => ({ ...f, severity: e.target.value as Issue['severity'] }))}>
            {(Object.keys(SEVERITY) as Issue['severity'][]).map(k => (
              <option key={k} value={k}>{SEVERITY[k].label} — {SEVERITY[k].hint}</option>
            ))}
          </Select>
          <p className="text-muted text-[11px]">
            The odometer reading is saved with it, so the workshop can see how long it has been going on.
          </p>
          {error && <p className="text-danger text-sm">{error}</p>}
          <Button fullWidth loading={add.isPending}
                  onClick={() => form.title.trim() ? add.mutate() : setError('Say what is wrong, even roughly.')}>
            Save note
          </Button>
        </div>
      </Modal>
    </div>
  );
}
