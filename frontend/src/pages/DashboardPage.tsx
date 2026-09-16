import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { BikeDashboard, Motorcycle } from '../types';
import { Card, Spinner, Empty, Button } from '../components/ui';
import MaintenanceTile from '../components/common/MaintenanceTile';
import { formatCurrency, formatDate } from '../lib/utils';
import { useGarageStore } from '../store/garageStore';

type Period = 'month' | 'year' | 'all';

/** Big number + unit, the cockpit-gauge look the spec asks for (§55). */
function Gauge({ label, value, unit, sub, tone = 'text-ink' }: {
  label: string; value: string; unit?: string; sub?: string; tone?: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-0.5 min-w-0">
      <span className="text-muted text-[10px] uppercase tracking-wider">{label}</span>
      <p className="flex items-baseline gap-1 min-w-0">
        <span className={`text-2xl font-black tabular-nums truncate ${tone}`}>{value}</span>
        {unit && <span className="text-muted text-xs flex-shrink-0">{unit}</span>}
      </p>
      {sub && <span className="text-muted text-[11px] truncate">{sub}</span>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-24 rounded-2xl bg-surface animate-pulse" />)}
      </div>
      <div className="h-32 rounded-2xl bg-surface animate-pulse" />
      <div className="h-40 rounded-2xl bg-surface animate-pulse" />
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { selectedBikeId } = useGarageStore();
  const [period, setPeriod] = useState<Period>('month');

  const { data: bikes, isLoading: bikesLoading } = useQuery<Motorcycle[]>({
    queryKey: ['bikes'], queryFn: () => api.get('/bikes'),
  });

  const bikeId = selectedBikeId || bikes?.[0]?.id || '';

  const { data, isLoading, error, refetch } = useQuery<BikeDashboard>({
    queryKey: ['bike-dashboard', bikeId, period],
    queryFn: () => api.get(`/analytics/bike/${bikeId}?period=${period}`),
    enabled: !!bikeId,
  });

  if (bikesLoading) { return <div className="h-full overflow-y-auto scroll-y p-4"><Skeleton /></div>;
  }

  if (!bikes?.length) {
    return (
      <div className="h-full overflow-y-auto scroll-y p-4">
        <Empty
          icon="🏍️"
          title="Add your motorcycle"
          desc="Everything else — fuel, service, maintenance, rides — hangs off a bike." action={<Button onClick={() => navigate('/garage')}>Add Bike</Button>}
        />
      </div>
    );
  }

  const periodLabel = period === 'month' ? 'This month' : period === 'year' ? 'This year' : 'All time';

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-5 pb-6">

        {isLoading ? <Skeleton /> : error ? (
          <Card className="border-danger/40 flex flex-col gap-3">
            <p className="text-danger font-semibold text-sm">Could not load your dashboard</p>
            <p className="text-muted text-xs">{(error as Error).message}</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
          </Card>
        ) : !data ? null : (
          <>
            {/* ── Headline gauges ─────────────────────────── */}
            <div className="grid grid-cols-2 gap-3">
              <Gauge
                label="Total distance"
                value={data.distance.total.toLocaleString()}
                unit="km"
                sub={`Odometer ${data.distance.current_odometer.toLocaleString()} km`}
              />
              <Gauge
                label="Mileage"
                value={data.mileage.reliable && data.mileage.value ? String(data.mileage.value) : '—'}
                unit={data.mileage.value ? 'km/L' : undefined}
                sub={data.mileage.reliable
                  ? `From ${data.mileage.samples} full tank${data.mileage.samples === 1 ? '' : 's'}`
                  : 'Log two full tanks'}
                tone={data.mileage.reliable ? 'text-green-400' : 'text-muted'}
              />
            </div>

            {data.range && (
              <Card className="flex items-center gap-3 py-3">
                <p className="text-sm text-ink flex-1">A full tank takes you about{' '}
                  <strong className="text-accent">{data.range.toLocaleString()} km</strong>
                </p>
              </Card>
            )}

            {/* ── Service ─────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3">
              <Card className="flex flex-col gap-1">
                <span className="text-muted text-[10px] uppercase tracking-wider">Last service</span>
                {data.last_service ? (
                  <>
                    <p className="text-ink font-bold text-sm">{formatDate(data.last_service.date)}</p>
                    <p className="text-muted text-[11px]">{data.last_service.odometer.toLocaleString()} km</p>
                    {data.last_service.workshop && (
                      <p className="text-muted text-[11px] truncate">{data.last_service.workshop}</p>
                    )}
                  </>
                ) : (
                  <p className="text-muted text-sm">Never recorded</p>
                )}
              </Card>

              <Card className="flex flex-col gap-1">
                <span className="text-muted text-[10px] uppercase tracking-wider">Next service</span>
                {data.next_service?.due_km != null ? (
                  <>
                    <p className="text-ink font-bold text-sm">{data.next_service.due_km.toLocaleString()} km</p>
                    <p className={`text-[11px] font-semibold ${
                      data.next_service.status === 'overdue' ? 'text-red-400': data.next_service.status === 'due' ? 'text-orange-400': data.next_service.status === 'due_soon' ? 'text-yellow-400' : 'text-green-400'}`}>
                      {data.next_service.km_remaining != null && data.next_service.km_remaining < 0
                        ? `${Math.abs(data.next_service.km_remaining).toLocaleString()} km overdue`
                        : `${(data.next_service.km_remaining ?? 0).toLocaleString()} km remaining`}
                    </p>
                  </>
                ) : (
                  <p className="text-muted text-sm">Not scheduled</p>
                )}
              </Card>
            </div>

            {/* ── Costs, with the period filter ───────────── */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-ink text-sm">Running cost</h2>
                <div className="flex gap-1 bg-surface2 rounded-lg p-0.5">
                  {(['month', 'year', 'all'] as Period[]).map(p => (
                    <button
                      key={p}
                      onClick={() => setPeriod(p)}
                      className={`btn3d btn3d-accent px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                        period === p ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
                    >
                      {p === 'month' ? 'Month' : p === 'year' ? 'Year' : 'Total'}
                    </button>
                  ))}
                </div>
              </div>

              <Card className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-muted text-xs">{periodLabel}</span>
                  <span className="text-2xl font-black text-ink tabular-nums">
                    {formatCurrency(data.costs.total)}
                  </span>
                </div>

                {/* Proportional bar — fuel vs service at a glance */}
                {data.costs.total >0 && (
                  <div className="flex h-2 rounded-full overflow-hidden bg-surface2" aria-hidden="true">
                    <div className="bg-orange-400" style={{ width: `${(data.costs.fuel / data.costs.total) * 100}%` }} />
                    <div className="bg-blue-400" style={{ width: `${(data.costs.service / data.costs.total) * 100}%` }} />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" />
                    <span className="text-muted text-xs flex-1">Fuel</span>
                    <span className="text-ink font-semibold tabular-nums">{formatCurrency(data.costs.fuel)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                    <span className="text-muted text-xs flex-1">Service</span>
                    <span className="text-ink font-semibold tabular-nums">{formatCurrency(data.costs.service)}</span>
                  </div>
                </div>

                {data.costs.cost_per_km != null && (
                  <p className="text-muted text-[11px] pt-1 border-t border-border">Lifetime running cost ₹{data.costs.cost_per_km}/km
                  </p>
                )}
              </Card>
            </div>

            {/* ── Upcoming maintenance (§4.3) ─────────────── */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-ink text-sm">Needs attention</h2>
                <Link to={`/garage/${data.bike.id}`} className="text-accent text-xs">All components →</Link>
              </div>

              {data.maintenance.attention.length === 0 ? (
                <Card className="flex items-center gap-3 py-4">
                  <span className="text-2xl"></span>
                  <div>
                    <p className="text-ink text-sm font-semibold">Everything is in good shape</p>
                    <p className="text-muted text-xs">
                      {data.maintenance.counts.healthy} components tracked and healthy
                    </p>
                  </div>
                </Card>
              ) : (
                <div className="flex flex-col gap-2">
                  {data.maintenance.attention.map(m => (
                    <MaintenanceTile key={m.id} item={m} onClick={() => navigate(`/garage/${data.bike.id}`)} />
                  ))}
                </div>
              )}
            </div>

            {/* ── Expiring paperwork ──────────────────────── */}
            {data.expiring_docs.length >0 && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-ink text-sm">Paperwork expiring</h2>
                  <Link to="/documents" className="text-accent text-xs">View all →</Link>
                </div>
                {data.expiring_docs.map(d => (
                  <Card key={d.id} className="flex items-center justify-between py-3">
                    <div className="min-w-0">
                      <p className="text-ink text-sm font-medium truncate">{d.title}</p>
                      <p className="text-muted text-xs">{d.doc_type} · {formatDate(d.expiry_date!)}</p>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* ── Quick actions, few taps (§2.1) ──────────── */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Fuel', to: '/fuel' },
                { label: 'Service', to: '/service' },
                { label: 'Ride', to: '/rides' },
                { label: 'Bike', to: `/garage/${data.bike.id}` },
              ].map(a => (
                <Link key={a.label} to={a.to}>
                  <div className="btn3d btn3d-surface bg-surface2 border border-border rounded-xl h-11
                                  flex items-center justify-center text-xs font-semibold text-ink">
                    {a.label}
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
