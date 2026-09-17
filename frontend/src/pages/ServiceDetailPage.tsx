import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ServiceRecord } from '../types';
import { Button, Card, Spinner, Empty, Badge } from '../components/ui';
import ServiceFormModal from '../components/service/ServiceFormModal';
import { formatCurrency, formatDate } from '../lib/utils';

/** Full detail for one service (spec §8.2). */
export default function ServiceDetailPage() {
  const { serviceId } = useParams<{ serviceId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data: record, isLoading } = useQuery<ServiceRecord>({
    queryKey: ['service', serviceId],
    queryFn: () => api.get(`/services/${serviceId}`),
    enabled: !!serviceId,
  });

  const del = useMutation({
    mutationFn: () => api.delete(`/services/${serviceId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['bike-dashboard'] });
      navigate('/service');
    },
  }); if (isLoading) return <div className="h-full flex items-center justify-center"><Spinner size="lg" /></div>;
  if (!record) {
    return <div className="p-4"><Empty title="Service not found" action={<Button onClick={() => navigate('/service')}>Back</Button>} /></div>;
  }

  const parts = record.service_parts ?? [];
  const partsTotal = parts.reduce((s, p) => s + (p.cost || 0), 0);
  const labour = (record as any).labour_cost ?? Math.max(0, (record.cost ?? 0) - partsTotal);
  const tax = (record as any).tax ?? 0;
  const other = (record as any).other_charges ?? 0;

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4 pb-6">

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-ink">{record.service_type || 'Service'}</h1>
            <p className="text-muted text-xs">
              {formatDate(record.service_date)} · {record.odometer.toLocaleString()} km
            </p>
          </div>
          {(record as any).service_number && (
            <Badge variant="info">#{(record as any).service_number}</Badge>
          )}
        </div>

        {/* Cost breakdown */}
        <Card className="flex flex-col gap-2">
          <p className="text-muted text-[10px] uppercase tracking-wider">Cost breakdown</p>
          <div className="flex justify-between text-sm"><span className="text-muted">Labour</span>
            <span className="text-ink tabular-nums">{formatCurrency(labour)}</span></div>
          <div className="flex justify-between text-sm"><span className="text-muted">Parts ({parts.length})</span>
            <span className="text-ink tabular-nums">{formatCurrency(partsTotal)}</span></div>
          {tax >0 && <div className="flex justify-between text-sm"><span className="text-muted">Tax</span>
            <span className="text-ink tabular-nums">{formatCurrency(tax)}</span></div>}
          {other >0 && <div className="flex justify-between text-sm"><span className="text-muted">Other</span>
            <span className="text-ink tabular-nums">{formatCurrency(other)}</span></div>}
          <div className="flex justify-between pt-2 border-t border-border">
            <span className="text-ink font-semibold">Total</span>
            <span className="text-ink font-bold text-lg tabular-nums">{formatCurrency(record.cost ?? 0)}</span>
          </div>
        </Card>

        {/* Where */}
        <Card className="flex flex-col gap-2 text-sm">
          <p className="text-muted text-[10px] uppercase tracking-wider">Service centre</p>
          <p className="text-ink">{record.workshop || 'Not recorded'}</p>
          {(record as any).advisor && <p className="text-muted text-xs">Advisor: {(record as any).advisor}</p>}
          {record.motorcycles && (
            <p className="text-accent text-xs">{record.motorcycles.brand} {record.motorcycles.model}</p>
          )}
        </Card>

        {/* Parts */}
        <div className="flex flex-col gap-2">
          <p className="text-muted text-[10px] uppercase tracking-wider">Replaced parts &amp; components</p>
          {!parts.length ? (
            <Card><p className="text-muted text-sm">No parts recorded for this service.</p></Card>
          ) : parts.map((p, i) => (
            <Card key={i} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-ink text-sm font-medium truncate">{p.part_name}</p>
                <p className="text-muted text-xs">
                  {[p.brand, `×${p.quantity}`, (p as any).part_number].filter(Boolean).join(' · ')}
                </p>
                {(p as any).warranty_months ? (
                  <p className="text-green-400 text-[11px]">{(p as any).warranty_months} month warranty</p>
                ) : null}
              </div>
              <span className="text-ink text-sm tabular-nums flex-shrink-0">{formatCurrency(p.cost || 0)}</span>
            </Card>
          ))}
        </div>

        {record.notes && (
          <Card>
            <p className="text-muted text-[10px] uppercase tracking-wider mb-1">Notes</p>
            <p className="text-ink text-sm whitespace-pre-wrap">{record.notes}</p>
          </Card>
        )}

        {(record as any).invoice_url && (
          <a href={(record as any).invoice_url} target="_blank" rel="noreferrer">
            <Button variant="outline" fullWidth>Open invoice</Button>
          </a>
        )}

        {/* Edit before delete, and the more prominent of the two: correcting a mistyped
            odometer or a missing part is the common case, and deleting to re-enter would
            lose the service number and the maintenance reset that came with it. */}
        <Button fullWidth onClick={() => setEditing(true)}>Edit service</Button>

        <Button
          variant="danger"
          fullWidth
          loading={del.isPending}
          onClick={() => {
            if (confirm('Delete this service record?\n\nThis cannot be undone. Maintenance clocks it reset will not be rolled back.')) del.mutate();
          }}
        >Delete service
        </Button>
      </div>

      <ServiceFormModal open={editing} onClose={() => setEditing(false)} record={record} />
    </div>
  );
}
