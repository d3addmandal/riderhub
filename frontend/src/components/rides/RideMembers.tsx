import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { RideMember } from '../../types';
import { Button, Card } from '../ui';
import { formatRelativeTime } from '../../lib/utils';

/**
 * Who is on this ride.
 *
 * Each rider gets the same coloured initial they are drawn with on the map, so matching
 * a dot to a name takes no thought. "Last seen" is the honest measure of whether the
 * group is actually in sync — a rider whose phone lost signal an hour ago should look
 * different from one reporting every few seconds.
 */
export default function RideMembers({ rideId, live }: { rideId: string; live?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data } = useQuery<{ members: RideMember[]; you_are_owner: boolean }>({
    queryKey: ['ride-members', rideId],
    queryFn: () => api.get(`/rides/${rideId}/members`),
    // Only worth re-asking while people are actually moving.
    refetchInterval: live ? 20000 : false,
  });

  const leave = useMutation({
    mutationFn: () => api.post(`/rides/${rideId}/leave`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rides'] });
      navigate('/rides');
    },
  });

  const members = data?.members ?? [];
  if (members.length <= 1) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold text-ink text-sm">Riding together</h2>
        <p className="text-muted text-xs">
          Nobody has joined yet. Share the invite code above and they will appear here.
        </p>
      </div>
    );
  }

  const you = members.find(m => m.is_you);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between">
        <h2 className="font-semibold text-ink text-sm">Riding together</h2>
        <span className="text-muted text-[11px]">{members.length} riders</span>
      </div>

      <div className="flex flex-col gap-2">
        {members.map(m => (
          <Card key={m.user_id} className="flex items-center gap-3 py-2.5">
            {/* The same badge that marks them on the map. */}
            <span
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-black
                         text-white flex-shrink-0 border-2 border-white/25"
              style={{ background: m.colour }}
            >
              {(m.name || '?').trim().charAt(0).toUpperCase()}
            </span>

            <div className="flex-1 min-w-0">
              <p className="text-ink text-sm font-semibold truncate">
                {m.name}
                {m.is_you && <span className="text-muted font-normal"> (you)</span>}
                {m.is_owner && <span className="text-accent font-normal"> · leading</span>}
              </p>
              <p className="text-muted text-[11px] truncate">
                {m.bike_name || 'Bike not set'}
                {m.start_location?.name && ` · from ${m.start_location.name}`}
              </p>
            </div>

            <span className="text-[11px] flex-shrink-0 text-right">
              {m.last_position
                ? <span className="text-muted">{formatRelativeTime(m.last_position.t)}</span>
                : <span className="text-muted">not started</span>}
            </span>
          </Card>
        ))}
      </div>

      {you && !you.is_owner && (
        <Button size="sm" variant="ghost" className="self-start" loading={leave.isPending}
                onClick={() => { if (confirm('Leave this ride?')) leave.mutate(); }}>
          Leave this ride
        </Button>
      )}
    </div>
  );
}
