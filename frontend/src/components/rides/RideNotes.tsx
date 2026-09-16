import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { RideNote } from '../../types';
import { Button, Card, Textarea, Icon } from '../ui';

/**
 * The ride's notebook.
 *
 * Riders remember things at the roadside and write them down at home, so notes are
 * editable in every status — a completed ride is exactly when the good ones get written.
 * Each entry is timestamped, and one taken mid-ride can carry the spot it was taken at.
 */
export default function RideNotes({ rideId, notes, canGeotag }: {
  rideId: string;
  notes: RideNote[];
  /** Offer to pin the note to the rider's current position — only useful while out. */
  canGeotag?: boolean;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [pinHere, setPinHere] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [error, setError] = useState('');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ride', rideId] });
    qc.invalidateQueries({ queryKey: ['rides'] });
  };

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/rides/${rideId}/notes`, body),
    onSuccess: () => { refresh(); setDraft(''); setError(''); },
    onError: (e: Error) => setError(e.message),
  });

  const edit = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => api.patch(`/rides/${rideId}/notes/${id}`, { text }),
    onSuccess: () => { refresh(); setEditingId(null); setError(''); },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/rides/${rideId}/notes/${id}`),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  function submit() {
    const text = draft.trim();
    if (!text) return;

    // Geotagging must never hold the note hostage — save it either way.
    if (pinHere && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        p => add.mutate({ text, lat: p.coords.latitude, lng: p.coords.longitude }),
        () => add.mutate({ text }),
        { enableHighAccuracy: true, timeout: 8000 }
      );
      return;
    }
    add.mutate({ text });
  }

  const sorted = [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink text-sm">Notes</h2>
        {!!notes.length && (
          <span className="text-muted text-xs">{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
        )}
      </div>

      <Card className="flex flex-col gap-2">
        <Textarea
          rows={2}
          placeholder="Fuel pump before the ghat · great chai at the second stop · rear tyre feels soft"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          {canGeotag ? (
            <label className="flex items-center gap-2 text-muted text-xs cursor-pointer">
              <input type="checkbox" checked={pinHere} onChange={e => setPinHere(e.target.checked)}
                     className="w-4 h-4 accent-accent" />
              Pin to where I am
            </label>
          ) : <span />}
          <Button size="sm" loading={add.isPending} disabled={!draft.trim()} onClick={submit}>Add note
          </Button>
        </div>
      </Card>

      {error && <p className="text-danger text-xs">{error}</p>}

      {!notes.length ? (
        <p className="text-muted text-xs px-1">Nothing yet. Notes stay with the ride — add them now or after you are home.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map(n => (
            <Card key={n.id} className="flex flex-col gap-1.5 py-3">
              {editingId === n.id ? (
                <>
                  <Textarea rows={3} value={editText} onChange={e => setEditText(e.target.value)} />
                  <div className="flex gap-2 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button size="sm" loading={edit.isPending} disabled={!editText.trim()} onClick={() => edit.mutate({ id: n.id, text: editText })}>Save</Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-ink text-sm whitespace-pre-wrap break-words">{n.text}</p>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-muted text-[10px]">
                      {stamp(n.created_at)}
                      {n.updated_at && ' · edited'}
                      {n.lat != null && ' ·  pinned'}
                    </p>
                    <div className="flex gap-0.5 flex-shrink-0 text-muted">
                      <button onClick={() => { setEditingId(n.id); setEditText(n.text); }}
                              className="btn3d btn3d-surface p-1.5 rounded-lg hover:text-ink hover:bg-surface2 transition-colors" aria-label="Edit note"><Icon name="edit" size={14} /></button>
                      <button onClick={() => { if (confirm('Delete this note?')) remove.mutate(n.id); }}
                              className="btn3d btn3d-surface p-1.5 rounded-lg hover:text-danger hover:bg-surface2 transition-colors" aria-label="Delete note"><Icon name="trash" size={14} /></button>
                    </div>
                  </div>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function stamp(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}
