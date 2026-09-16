import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isSignInWithEmailLink, signInWithEmailLink } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { useAuthStore } from '../store/authStore';
import { Button, Input, Icon } from '../components/ui';

type Step = 'choose' | 'email' | 'link-sent' | 'confirm-email';

export default function AuthPage() {
  const { signInWithGoogle, sendEmailLink, user } = useAuthStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('choose');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user]);

  // Landing here from a sign-in link with no stored address means the link was
  // opened on another device. Ask for the email so the link can still be redeemed.
  useEffect(() => {
    if (isSignInWithEmailLink(auth, window.location.href) && !user) {
      setStep('confirm-email');
    }
  }, [user]);

  async function handleGoogleLogin() {
    setError('');
    try {
      await signInWithGoogle();
    } catch (e: any) {
      if (e?.code === 'auth/popup-closed-by-user') return;
      setError(e.message);
    }
  }

  async function handleSendLink() {
    if (!email.trim()) { setError('Enter your email address'); return; }
    setLoading(true); setError('');
    try {
      await sendEmailLink(email.trim());
      setStep('link-sent');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmEmail() {
    if (!email.trim()) { setError('Enter the email you requested the link with'); return; }
    setLoading(true); setError('');
    try {
      await signInWithEmailLink(auth, email.trim(), window.location.href);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-5">
      <div className="w-full max-w-sm flex flex-col gap-8">

        {/* Logo */}
        <div className="text-center">
          <div className="text-6xl mb-3">🏍️</div>
          <h1 className="text-3xl font-black text-ink">RiderHub</h1>
          <p className="text-muted text-sm mt-1">Your complete motorcycle companion</p>
        </div>

        {/* Card */}
        <div className="bg-surface border border-border rounded-2xl p-6 flex flex-col gap-4">
          {step === 'choose' && (
            <>
              <h2 className="text-ink font-semibold text-center">Sign in to continue</h2>
              <Button variant="outline" fullWidth onClick={handleGoogleLogin} className="gap-3">
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" className="w-5 h-5" />
                Continue with Google
              </Button>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-muted text-xs">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <Button variant="ghost" fullWidth onClick={() => setStep('email')}>Continue with Email Link
              </Button>
            </>
          )}

          {step === 'email' && (
            <>
              <button onClick={() => setStep('choose')}
                      className="text-muted text-sm font-semibold flex items-center gap-1.5 hover:text-ink
                                 transition-colors self-start -ml-1 px-1 py-1 rounded-lg">
                <Icon name="back" size={16} /> Back
              </button>
              <h2 className="text-ink font-semibold">Enter your email</h2>
              <p className="text-muted text-sm">We'll send you a link that signs you straight in — no password needed.</p>
              <Input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendLink()} autoFocus />
              <Button fullWidth loading={loading} onClick={handleSendLink}>Send Sign-in Link</Button>
            </>
          )}

          {step === 'link-sent' && (
            <>
              <div className="text-center text-4xl"></div>
              <h2 className="text-ink font-semibold text-center">Check your email</h2>
              <p className="text-muted text-sm text-center">We sent a sign-in link to <strong className="text-ink">{email}</strong>.
                Open it on this device to continue.
              </p>
              <Button variant="ghost" fullWidth loading={loading} onClick={handleSendLink}>Resend link</Button>
              <button onClick={() => setStep('email')} className="text-muted text-sm text-center hover:text-ink">Use a different email</button>
            </>
          )}

          {step === 'confirm-email' && (
            <>
              <h2 className="text-ink font-semibold">Confirm your email</h2>
              <p className="text-muted text-sm">You opened the sign-in link on a different device. Enter the address you
                requested it with to finish signing in.
              </p>
              <Input type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleConfirmEmail()} autoFocus />
              <Button fullWidth loading={loading} onClick={handleConfirmEmail}>Sign In</Button>
            </>
          )}

          {error && <p className="text-danger text-sm text-center">{error}</p>}
        </div>

        <p className="text-muted text-xs text-center">By continuing you agree to our Terms of Service</p>
      </div>
    </div>
  );
}
