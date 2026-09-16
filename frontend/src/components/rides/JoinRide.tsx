import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Motorcycle, RideLookup, RidePoint } from '../../types';
import { Button, Modal, Input, Select } from '../ui';
import PlacePicker from '../common/PlacePicker';
import { useGarageStore } from '../../store/garageStore';

/**
 * Join someone else's ride with their invite code.
 *
 * Two steps on purpose. Typing a code should first tell you *what* you are about to join
 * — whose ride, going where, how many are already in — because a six-character code is
 * meaningless on its own and joining the wrong ride is a confusing thing to undo.
 *
 * The destination is fixed by whoever created the ride; only the starting point is the
 * joiner's own, since riders meet on the way rather than all setting off from one place.
 */
export default function JoinRide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { selectedBikeId } = useGarageStore();

  const [code, setCode] = useState('');
  const [found, setFound] = useState<RideLookup | null>(null);
  const [bikeId, setBikeId] = useState('');
  const [start, setStart] = useState<RidePoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { data: bikes } = useQuery<Motorcycle[]>({
    queryKey: ['bikes'], queryFn: () => api.get('/bikes'), enabled: open,
  });

  function reset() {
    setCode(''); setFound(null); setStart(null); setError(''); setBusy(false);
  }

  async function lookup() {
    const c = code.trim().toUpperCase();
    if (!c) { setError('Enter the code your friend shared.'); return; }
    setBusy(true); setError('');
    try {
      const r = await api.get<RideLookup>(`/rides/lookup?code=${encodeURIComponent(c)}`);
      setFound(r);
      setBikeId(selectedBikeId || bikes?.[0]?.id || '');
    } catch (e: any) {
      setError(e.message || 'Could not find that ride.');
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!found || !bikeId) { setError('Choose which bike you are taking.'); return; }
    setBusy(true); setError('');
    try {
      const r = await api.post<{ ride_id: string }>('/rides/join', {
        code: code.trim().toUpperCase(),
        motorcycle_id: bikeId,
        start_location: start?.name.trim() ? start : undefined,
      });
      await qc.invalidateQueries({ queryKey: ['rides'] });
      onClose();
      reset();
      navigate(`/rides/${r.ride_id}`);
    } catch (e: any) {
      setError(e.message || 'Could not join that ride.');
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { onClose(); reset(); }} title="Join a ride">
      <div className="flex flex-col gap-3">

        {!found ? (
          <>
            <Input
              label="Invite code"
              placeholder="e.g. 4F2A9C"
              value={code}
              autoCapitalize="characters"
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && void lookup()}
            />
            <p className="text-muted text-xs">
              Whoever created the ride can share this from the ride screen.
            </p>
            {error && <p className="text-danger text-sm">{error}</p>}
            <Button fullWidth loading={busy} disabled={!code.trim()} onClick={() => void lookup()}>
              Find ride
            </Button>
          </>
        ) : (
          <>
            {/* What you are about to join, before you commit to it */}
            <div className="bg-surface2 border border-border rounded-xl p-3 flex flex-col gap-1">
              <p className="text-ink font-bold">{found.name}</p>
              <p className="text-muted text-xs">
                Led by {found.owner_name} · <span className="capitalize">{found.ride_type}</span>
                {found.member_count > 0 && ` · ${found.member_count} riding`}
              </p>
              {found.destination?.name && (
                <p className="text-muted text-xs">Heading to {found.destination.name}</p>
              )}
            </div>

            {found.is_owner && <p className="text-danger text-sm">This is your own ride.</p>}
            {found.already_joined && (
              <p className="text-muted text-sm">
                You are already on this ride.{' '}
                <button className="text-accent underline"
                        onClick={() => { onClose(); navigate(`/rides/${found.id}`); }}>
                  Open it
                </button>
              </p>
            )}
            {!found.joinable && !found.is_owner && !found.already_joined && (
              <p className="text-danger text-sm">
                {found.ride_type === 'solo'
                  ? 'That is a solo ride — it cannot be joined.'
                  : `That ride is already ${found.status}.`}
              </p>
            )}

            {found.joinable && !found.is_owner && !found.already_joined && (
              <>
                <Select label="Which bike are you taking?" value={bikeId}
                        onChange={e => setBikeId(e.target.value)}>
                  <option value="">Select bike</option>
                  {(bikes ?? []).map(b => (
                    <option key={b.id} value={b.id}>{b.brand} {b.model}</option>
                  ))}
                </Select>
                {!bikes?.length && (
                  <p className="text-muted text-xs">Add a bike in your garage first.</p>
                )}

                {/* Same destination for everyone; the start is yours. */}
                <PlacePicker
                  label="Where are you setting off from?"
                  placeholder="Leave blank to start from where you are"
                  value={start}
                  onChange={setStart}
                />
                <p className="text-muted text-[11px]">
                  Everyone rides to {found.destination?.name || 'the same destination'}, but you
                  can start from anywhere.
                </p>

                {error && <p className="text-danger text-sm">{error}</p>}
                <Button fullWidth loading={busy} disabled={!bikeId} onClick={() => void join()}>
                  Join ride
                </Button>
              </>
            )}

            <Button fullWidth variant="ghost" onClick={reset}>Try another code</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
