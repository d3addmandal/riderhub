import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ServiceRecord } from '../types';
import { Button, Card, Empty } from '../components/ui';
import ServiceFormModal from '../components/service/ServiceFormModal';
import { formatCurrency, formatDate } from '../lib/utils';

export default function ServicePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);

  const { data: records, isLoading } = useQuery<ServiceRecord[]>({
    queryKey: ['services'],
    queryFn: () => api.get('/services'),
  });

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
            desc="Log every workshop visit — it keeps your maintenance clocks accurate and builds a service history for resale."
            action={<Button onClick={() => setShowAdd(true)}>Add Service</Button>} />
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

      <ServiceFormModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        defaultBikeId={params.get('bike') || ''}
      />
    </div>
  );
}
