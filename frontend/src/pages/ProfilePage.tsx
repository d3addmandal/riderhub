import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { EmergencyContact } from '../types';
import { Button, Input, Select, Spinner } from '../components/ui';
import ThemePicker from '../components/common/ThemePicker';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Your club's bot, without the @. Set VITE_TELEGRAM_BOT_USERNAME in frontend/.env —
// `npm run telegram` prints the exact username for the token in backend/.env.
const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'RiderHubBot';

export default function ProfilePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { profile, fetchProfile, signOut } = useAuthStore();
  /** Two slots, always present so the inputs stay controlled. */
  const [contacts, setContacts] = useState<EmergencyContact[]>([{}, {}]);

  /** Patch one slot without disturbing the other. */
  function setContact(i: number, patch: Partial<EmergencyContact>) {
    setContacts(prev => {
      const next: EmergencyContact[] = [prev[0] ?? {}, prev[1] ?? {}];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  const [form, setForm] = useState({
    name: '', phone: '', city: '', country: 'India', blood_group: '', medical_notes: '',
    emergency_contact_name: '', emergency_contact_phone: '', telegram_chat_id: '',
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile) {
      // Older profiles only have the single legacy pair; lift it into slot one so
      // nobody has to re-enter a contact they already saved.
      const saved = profile.emergency_contacts?.length
        ? profile.emergency_contacts
        : (profile.emergency_contact_phone
            ? [{ name: profile.emergency_contact_name, phone: profile.emergency_contact_phone }]
            : []);
      setContacts([saved[0] ?? {}, saved[1] ?? {}]);
    }
    if (profile) setForm({ name: profile.name || '', phone: profile.phone || '', city: profile.city || '', country: profile.country || 'India', blood_group: profile.blood_group || '', medical_notes: profile.medical_notes || '', emergency_contact_name: profile.emergency_contact_name || '', emergency_contact_phone: profile.emergency_contact_phone || '', telegram_chat_id: profile.telegram_chat_id || '' });
  }, [profile]);

  const save = useMutation({
    mutationFn: (data: typeof form & { emergency_contacts?: EmergencyContact[] }) =>
      api.put('/users/profile', data),
    onSuccess: async () => { await fetchProfile(); setSaved(true); setTimeout(() => setSaved(false), 2500); },
  });

  const links = [
    { to: '/service', icon: '', label: 'Service History' },
    { to: '/reminders', icon: '', label: 'Reminders' },
    { to: '/documents', icon: '', label: 'Documents' },
    { to: '/sos', icon: '', label: 'SOS Setup' },
  ];

  return (
    <div className="h-full overflow-y-auto scroll-y">
      <div className="p-4 flex flex-col gap-5">
        <div className="flex items-center justify-between pt-2">
          <h1 className="text-xl font-bold text-ink">Profile</h1>
          <Button size="sm" variant="ghost" onClick={() => { if (confirm('Sign out?')) signOut().then(() => navigate('/auth')); }} className="text-danger">Sign Out</Button>
        </div>

        {/* Avatar */}
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center text-accent-ink text-2xl font-black">
            {(form.name || 'R')[0].toUpperCase()}
          </div>
          <div>
            <p className="text-ink font-bold text-lg">{form.name || 'Rider'}</p>
            <p className="text-muted text-sm">{useAuthStore.getState().user?.email}</p>
          </div>
        </div>

        {/* Appearance */}
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold text-ink">Appearance</h2>
          <ThemePicker />
        </div>

        {/* Profile Form */}
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold text-ink">Basic Info</h2>
          <Input label="Full Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Phone" type="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            <Input label="City" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
          </div>
        </div>

        {/* Medical */}
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold text-ink">Emergency Info</h2>
          <Select label="Blood Group" value={form.blood_group} onChange={e => setForm(f => ({ ...f, blood_group: e.target.value }))}>
            <option value="">Select blood group</option>
            {BLOOD_GROUPS.map(g => <option key={g}>{g}</option>)}
          </Select>
          <Input label="Medical Notes" placeholder="Allergies, conditions…" value={form.medical_notes} onChange={e => setForm(f => ({ ...f, medical_notes: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <p className="text-muted text-[11px]">
              Up to two people. WhatsApp is a separate field because it is often a
              different number, and sending to the wrong one only shows up when it matters.
            </p>
            {[0, 1].map(i => (
              <div key={i} className="bg-surface2 border border-border rounded-xl p-3 flex flex-col gap-2.5">
                <p className="text-muted text-[10px] uppercase tracking-wider">
                  Contact {i + 1}{i === 0 ? ' - called when you hold SOS' : ''}
                </p>
                <Input label="Name" placeholder="Who to call"
                       value={contacts[i]?.name ?? ''}
                       onChange={e => setContact(i, { name: e.target.value })} />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Phone" type="tel" inputMode="tel" placeholder="+91 98765 43210"
                         value={contacts[i]?.phone ?? ''}
                         onChange={e => setContact(i, { phone: e.target.value })} />
                  <Input label="WhatsApp" type="tel" inputMode="tel" placeholder="If different"
                         value={contacts[i]?.whatsapp ?? ''}
                         onChange={e => setContact(i, { whatsapp: e.target.value })} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Telegram */}
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold text-ink">Telegram Notifications</h2>
          <div className="bg-surface2 rounded-xl p-3 text-sm text-muted flex flex-col gap-1.5">
            <p>1. Open{' '}
              <a href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noreferrer" className="text-accent font-semibold">
                @{BOT_USERNAME}
              </a>{' '} and press <strong className="text-ink">Start</strong>
            </p>
            <p className="text-xs pl-4">Telegram blocks bots from messaging you until you do this.</p>
            <p>2. Open{' '}
              <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-accent font-semibold">
                @userinfobot
              </a>{' '}
              — it replies with your numeric ID
            </p>
            <p>3. Paste that number below and save</p>
          </div>
          <Input label="Telegram Chat ID" placeholder="123456789" value={form.telegram_chat_id} onChange={e => setForm(f => ({ ...f, telegram_chat_id: e.target.value }))} />
          <p className="text-muted text-xs">Used for SOS alerts and maintenance reminders. Leave blank to turn them off.
          </p>
        </div>

        <Button fullWidth loading={save.isPending} onClick={() => save.mutate({
          ...form,
          emergency_contacts: contacts.filter(c => c.name?.trim() || c.phone?.trim() || c.whatsapp?.trim()),
          // Slot one is mirrored into the legacy fields so anything still reading them
          // keeps working.
          emergency_contact_name: contacts[0]?.name ?? '',
          emergency_contact_phone: contacts[0]?.phone ?? '',
        })} variant={saved ? 'secondary' : 'primary'}>
          {saved ? ' Saved!' : 'Save Profile'}
        </Button>

        {/* Quick links */}
        <div className="grid grid-cols-2 gap-3">
          {links.map(({ to, icon, label }) => (
            <Link key={to} to={to}>
              <div className="btn3d btn3d-surface bg-surface border border-border rounded-xl p-4 flex items-center gap-3">
                <span className="text-xl">{icon}</span>
                <span className="text-sm font-medium text-ink">{label}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
