import { create } from 'zustand';
import {
  User,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut as fbSignOut,
} from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import { api } from '../lib/api';
import { Profile } from '../types';

// Firebase remembers who requested the link so the same device can complete it
// without retyping the address.
const EMAIL_KEY = 'riderhub:emailForSignIn';

interface AuthState {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  setProfile: (profile: Profile | null) => void;
  signInWithGoogle: () => Promise<void>;
  sendEmailLink: (email: string) => Promise<void>;
  /** Completes an email-link sign-in if the current URL is one. Returns true when it signed in. */
  completeEmailLink: () => Promise<boolean>;
  pendingEmail: () => string | null;
  signOut: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  loading: true,

  setUser: (user) => set({ user }),

  setProfile: (profile) => set({ profile }),

  signInWithGoogle: async () => {
    await signInWithPopup(auth, googleProvider);
  },

  sendEmailLink: async (email: string) => {
    await sendSignInLinkToEmail(auth, email, {
      url: `${window.location.origin}/auth/callback`,
      handleCodeInApp: true,
    });
    window.localStorage.setItem(EMAIL_KEY, email);
  },

  completeEmailLink: async () => {
    const href = window.location.href;
    if (!isSignInWithEmailLink(auth, href)) return false;

    // Opening the link on a different device leaves nothing in localStorage —
    // AuthPage prompts for the address again in that case.
    const email = window.localStorage.getItem(EMAIL_KEY);
    if (!email) return false;

    await signInWithEmailLink(auth, email, href);
    window.localStorage.removeItem(EMAIL_KEY);
    return true;
  },

  pendingEmail: () => window.localStorage.getItem(EMAIL_KEY),

  signOut: async () => {
    await fbSignOut(auth);
    set({ user: null, profile: null });
  },

  fetchProfile: async () => {
    if (!get().user) return;
    try {
      // The backend creates the profile document on first call, so this never 404s
      // for a freshly registered rider.
      const profile = await api.get<Profile>('/users/me');
      set({ profile });
    } catch (e) {
      console.error('Failed to load profile:', e);
    }
  },
}));
