import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Document, Motorcycle } from '../types';
import { Button, Card, Input, Select, Modal, Spinner, Empty, Badge } from '../components/ui';
import { formatDate, daysUntil } from '../lib/utils';

const DOC_TYPES = ['RC', 'Insurance', 'PUC', 'Driving License', 'Service Invoice', 'Purchase Invoice', 'Other'];
const DOC_ICONS: Record<string, string> = { RC: '', Insurance: '', PUC: '', 'Driving License': '', 'Service Invoice': '', 'Purchase Invoice': '', Other: '' };

const EMPTY_FORM = {
  motorcycle_id: '', doc_type: 'Insurance', title: '', issuer: '',
  policy_number: '', issue_date: '', expiry_date: '', notes: '',
};

export default function DocumentsPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Document | null>(null);
  const [filterType, setFilterType] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: bikes } = useQuery<Motorcycle[]>({ queryKey: ['bikes'], queryFn: () => api.get('/bikes') });

  const { data: docs, isLoading } = useQuery<Document[]>({
    queryKey: ['documents', filterType],
    queryFn: () => api.get(`/documents${filterType ? `?doc_type=${filterType}` : ''}`),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  function openAdd() {
    setEditing(null); setForm(EMPTY_FORM); setError(''); setShowAdd(true);
  }

  function openEdit(doc: Document) {
    setEditing(doc);
    setForm({
      motorcycle_id: doc.motorcycle_id || '', doc_type: doc.doc_type, title: doc.title,
      issuer: doc.issuer || '', policy_number: doc.policy_number || '',
      issue_date: doc.issue_date || '', expiry_date: doc.expiry_date || '', notes: doc.notes || '',
    });
    setError(''); setShowAdd(true);
  }

  async function handleSubmit() {
    if (!form.title.trim()) { setError('Give it a name, e.g. "HDFC Ergo 2026"'); return; }
    setSaving(true); setError('');
    try {
      const body = {
        motorcycle_id: form.motorcycle_id || undefined,
        doc_type: form.doc_type,
        title: form.title.trim(),
        issuer: form.issuer.trim() || undefined,
        policy_number: form.policy_number.trim() || undefined,
        issue_date: form.issue_date || undefined,
        expiry_date: form.expiry_date || undefined,
        notes: form.notes.trim() || undefined,
      };
      if (editing) await api.put(`/documents/${editing.id}`, body);
      else await api.post('/documents', body);

      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setShowAdd(false);
      setForm(EMPTY_FORM);
      setEditing(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function expiryBadge(expiry_date?: string) {
    if (!expiry_date) return null;
    const days = daysUntil(expiry_date); if (days < 0) return <Badge variant="danger">Expired</Badge>; if (days <= 7) return <Badge variant="danger">{days}d left</Badge>; if (days <= 30) return <Badge variant="warning">{days}d left</Badge>; return <Badge variant="success">{days}d left</Badge>;
  }

  // Soonest expiry first; undated entries sink to the bottom.
  const sorted = [...(docs || [])].sort((a, b) => {
    if (!a.expiry_date) return 1;
    if (!b.expiry_date) return -1;
    return a.expiry_date.localeCompare(b.expiry_date);
  });

  const expiringSoon = sorted.filter(d => d.expiry_date && daysUntil(d.expiry_date) <= 30);

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between pt-2">
          <div>
            <h1 className="text-xl font-bold text-ink">Documents</h1>
            <p className="text-muted text-xs">Track expiry dates — never get caught at a checkpoint</p>
          </div>
          <Button size="sm" onClick={openAdd}>+ Add</Button>
        </div>

        {expiringSoon.length >0 && (
          <div className="bg-danger/10 border border-danger/30 rounded-xl px-4 py-3">
            <p className="text-danger text-sm font-semibold">
               {expiringSoon.length} document{expiringSoon.length >1 ? 's' : ''} expiring within 30 days
            </p>
          </div>
        )}

        <div className="flex gap-2 overflow-x-auto pb-1">
          {['', ...DOC_TYPES].map(t => (
            <button key={t} onClick={() => setFilterType(t)} className={`btn3d btn3d-accent px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors ${filterType === t ? 'bg-accent text-accent-ink' : 'bg-surface2 text-muted hover:text-ink'}`}>
              {t || 'All'}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : !sorted.length ? (
          <Empty title="Nothing tracked yet" desc="Add your Insurance, PUC, RC and licence to get expiry reminders" action={<Button onClick={openAdd}>Add Document</Button>} />
        ) : (
          <div className="flex flex-col gap-2">
            {sorted.map(doc => (
              <Card key={doc.id} className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-surface2 flex items-center justify-center text-xl flex-shrink-0">{DOC_ICONS[doc.doc_type] || ''}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-ink text-sm truncate">{doc.title}</p>
                    {expiryBadge(doc.expiry_date)}
                  </div>
                  <p className="text-muted text-xs">
                    {doc.doc_type}
                    {doc.issuer ? ` · ${doc.issuer}` : ''}
                    {doc.expiry_date ? ` · Expires ${formatDate(doc.expiry_date)}` : ' · No expiry set'}
                  </p>
                  {doc.policy_number && <p className="text-muted text-xs font-mono truncate">#{doc.policy_number}</p>}
                  {doc.motorcycles && <p className="text-accent text-xs">{doc.motorcycles.brand} {doc.motorcycles.model}</p>}
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(doc)}>Edit</Button>
                  <Button size="sm" variant="danger" onClick={() => { if (confirm(`Delete "${doc.title}"?`)) del.mutate(doc.id); }}>Del</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title={editing ? 'Edit Document' : 'Track a Document'}>
        <div className="flex flex-col gap-3">
          <Select label="Document Type" value={form.doc_type} onChange={e => setForm(f => ({ ...f, doc_type: e.target.value }))}>
            {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
          </Select>
          <Input label="Name" placeholder="HDFC Ergo 2026" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Issuer (optional)" placeholder="HDFC Ergo" value={form.issuer} onChange={e => setForm(f => ({ ...f, issuer: e.target.value }))} />
            <Input label="Policy / Ref No." placeholder="POL123456" value={form.policy_number} onChange={e => setForm(f => ({ ...f, policy_number: e.target.value }))} />
          </div>
          {bikes && bikes.length >0 && (
            <Select label="Bike (optional)" value={form.motorcycle_id} onChange={e => setForm(f => ({ ...f, motorcycle_id: e.target.value }))}>
              <option value="">Not linked to a bike</option>
              {bikes.map(b => <option key={b.id} value={b.id}>{b.brand} {b.model}</option>)}
            </Select>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Issued On" type="date" value={form.issue_date} onChange={e => setForm(f => ({ ...f, issue_date: e.target.value }))} />
            <Input label="Expires On" type="date" value={form.expiry_date} onChange={e => setForm(f => ({ ...f, expiry_date: e.target.value }))} />
          </div>
          <Input label="Notes (optional)" placeholder="Kept in the tank bag" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />

          <p className="text-muted text-xs">RiderHub tracks the details and warns you before expiry. Keep the actual document
            with you or in your own cloud drive.
          </p>

          {error && <p className="text-danger text-sm">{error}</p>}
          <Button fullWidth loading={saving} onClick={handleSubmit} disabled={!form.title.trim()}>
            {editing ? 'Save Changes' : 'Add Document'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
