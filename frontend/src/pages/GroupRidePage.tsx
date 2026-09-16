import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { RideGroup } from '../types';
import { Button, Card, Input, Modal, Badge, Empty, Spinner } from '../components/ui';
import ShareInvite from '../components/common/ShareInvite';
import { useRideStore } from '../store/rideStore';
import { useAuthStore } from '../store/authStore';
import { formatDate } from '../lib/utils';

export default function GroupRidePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { profile } = useAuthStore();
  const { setActiveGroup } = useRideStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');

  const { data: groups, isLoading } = useQuery<{ ride_groups: RideGroup; color_code: string }[]>({
    queryKey: ['groups'],
    queryFn: () => api.get('/groups'),
  });

  const createGroup = useMutation({
    mutationFn: () => api.post<RideGroup>('/groups', { name: groupName }),
    onSuccess: (group) => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      setActiveGroup(group);
      setShowCreate(false);
      setGroupName('');
      navigate(`/rides/${group.id}/map`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const joinGroup = useMutation({
    mutationFn: () => api.get<{ group: RideGroup }>(`/groups/join/${joinCode.toUpperCase()}`),
    onSuccess: ({ group }) => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      setActiveGroup(group);
      setShowJoin(false);
      setJoinCode('');
      navigate(`/rides/${group.id}/map`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const activeGroups = (groups || []).filter(g => g.ride_groups?.status === 'active');
  const pastGroups = (groups || []).filter(g => g.ride_groups?.status === 'ended');

  function openRide(group: RideGroup) {
    setActiveGroup(group);
    navigate(`/rides/${group.id}/map`);
  }

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between pt-2">
          <h1 className="text-xl font-bold text-ink">Group Rides</h1>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setError(''); setShowJoin(true); }}>Join</Button>
            <Button size="sm" onClick={() => { setError(''); setShowCreate(true); }}>Create</Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : activeGroups.length === 0 && pastGroups.length === 0 ? (
          <Empty icon="🏍️" title="No group rides yet" desc="Create a group and invite your riding buddies" action={
            <div className="flex gap-3">
              <Button onClick={() => setShowCreate(true)}>Create Group</Button>
              <Button variant="outline" onClick={() => setShowJoin(true)}>Join Group</Button>
            </div>
          } />
        ) : (
          <>
            {activeGroups.length >0 && (
              <div>
                <h2 className="font-semibold text-ink mb-3">Active Rides</h2>
                <div className="flex flex-col gap-2">
                  {activeGroups.map(({ ride_groups: g, color_code }) => (
                    <Card key={g.id} className="flex flex-col gap-3">
                      <div className="flex items-center gap-3 cursor-pointer" onClick={() => openRide(g)}>
                        <div className="w-10 h-10 rounded-full flex-shrink-0" style={{ background: color_code }} />
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-ink">{g.name}</p>
                          {g.destination_name && <p className="text-muted text-xs">to {g.destination_name}</p>}
                        </div>
                        <Badge variant="success">Live</Badge>
                      </div>
                      {/* Handing the code to the others is the whole point of a group ride. */}
                      <ShareInvite code={g.invite_code} rideName={g.name} />
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {pastGroups.length >0 && (
              <div>
                <h2 className="font-semibold text-muted mb-3">Past Rides</h2>
                <div className="flex flex-col gap-2">
                  {pastGroups.slice(0, 5).map(({ ride_groups: g }) => (
                    <Card key={g.id} className="flex items-center gap-3 opacity-60">
                      <div className="w-10 h-10 rounded-xl bg-surface2 flex items-center justify-center text-xl"></div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-ink">{g.name}</p>
                        <p className="text-muted text-xs">{formatDate(g.created_at)}</p>
                      </div>
                      <Badge>Ended</Badge>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Create Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Group Ride">
        <div className="flex flex-col gap-4">
          <Input label="Group Name" placeholder="Weekend Ride, Ladakh 2025…" value={groupName} onChange={e => setGroupName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createGroup.mutate()} autoFocus />
          {error && <p className="text-danger text-sm">{error}</p>}
          <Button fullWidth loading={createGroup.isPending} onClick={() => { if (groupName.trim()) createGroup.mutate(); else setError('Enter a group name'); }}>Create & Open Map</Button>
        </div>
      </Modal>

      {/* Join Modal */}
      <Modal open={showJoin} onClose={() => setShowJoin(false)} title="Join Group Ride">
        <div className="flex flex-col gap-4">
          <Input label="Room Code" placeholder="AB12CD" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={6} className="text-center text-2xl tracking-widest font-mono font-bold uppercase" autoFocus />
          {error && <p className="text-danger text-sm">{error}</p>}
          <Button fullWidth loading={joinGroup.isPending} onClick={() => { if (joinCode.trim().length >= 4) joinGroup.mutate(); else setError('Enter a valid code'); }}>Join Ride</Button>
        </div>
      </Modal>
    </div>
  );
}
