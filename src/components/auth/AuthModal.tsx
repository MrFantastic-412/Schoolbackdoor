import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogIn,
  Mail,
  ShieldCheck,
  Trash2,
  User,
  UserPlus,
} from 'lucide-react';
import { api } from '../../api/client';
import { StudentProfile } from '../../types';
import { GlassButton, GlassInput, GlassModal, GlassTab } from '../glass';
import { SchoolbackdoorLogo } from '../glass/SchoolbackdoorLogo';
import { UserAvatar } from '../common/UserAvatar';
import { AvatarCropModal } from '../profile/AvatarCropModal';
import { IMAGE_UPLOAD_GUIDANCE } from '../../utils/imageCompression';
import { triggerHaptic } from '../../utils/haptics';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: (profile: StudentProfile, message?: string) => void;
  initialMode?: 'login' | 'register' | 'forgot';
}

const GMAIL_REGEX = /^[a-z0-9._%+-]+@gmail\.com$/i;
const USERNAME_REGEX = /^@[a-zA-Z0-9_]{2,24}$/;

const COMMON_WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password1!',
  'password12',
  'password123',
  'p@ssword1',
  'p@ssw0rd',
  'qwerty123!',
  'qwerty123',
  '12345678',
  '12345678!',
  '12345678a!',
  'admin123!',
  'welcome1!',
  'welcome123!',
  'letmein1!',
  'letmein123!',
  'futastudent1!',
  'schoolbackdoor1!',
  'iloveyou1!',
  'changeme1!',
  'abc12345!',
]);

function evaluatePasswordStrength(pwd: string, username?: string, email?: string) {
  const hasMinLen = pwd.length >= 8 && pwd.length <= 128;
  const hasUpper = /[A-Z]/.test(pwd);
  const hasLower = /[a-z]/.test(pwd);
  const hasNumber = /[0-9]/.test(pwd);
  const hasSymbol = /[^A-Za-z0-9\s]/.test(pwd);
  const isCommon = COMMON_WEAK_PASSWORDS.has(pwd.toLowerCase());
  const cleanUser = (username || '').replace(/^@/, '').trim().toLowerCase();
  const cleanEmail = (email || '').split('@')[0]?.trim().toLowerCase() || '';
  const containsIdentity =
    (cleanUser.length >= 4 && pwd.toLowerCase().includes(cleanUser)) ||
    (cleanEmail.length >= 4 && pwd.toLowerCase().includes(cleanEmail));

  let error: string | null = null;
  if (!hasMinLen) error = 'Password must be between 8 and 128 characters.';
  else if (!hasUpper) error = 'Include at least one uppercase letter.';
  else if (!hasLower) error = 'Include at least one lowercase letter.';
  else if (!hasNumber) error = 'Include at least one number.';
  else if (!hasSymbol) error = 'Include at least one symbol (e.g., !@#$%).';
  else if (isCommon) error = 'This password is too common. Choose a stronger combination.';
  else if (containsIdentity) error = 'Password cannot contain your username or email.';

  return {
    valid: error === null,
    error,
    checks: [
      { label: '8+ characters', met: hasMinLen },
      { label: 'Uppercase & lowercase', met: hasUpper && hasLower },
      { label: 'Number', met: hasNumber },
      { label: 'Symbol (!@#$)', met: hasSymbol },
    ],
  };
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onAuthSuccess,
  initialMode = 'login',
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset' | 'verifyEmail'>(initialMode);
  const [identifier, setIdentifier] = useState('');
  const [gmail, setGmail] = useState('');
  const [username, setUsername] = useState('@');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState('');

  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);

  const [verifyCodeInput, setVerifyCodeInput] = useState('');
  const [pendingProfile, setPendingProfile] = useState<StudentProfile | null>(null);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [pendingAvatar, setPendingAvatar] = useState<{
    dataUrl: string;
    thumbnailDataUrl: string;
  } | null>(null);
  const [isCropModalOpen, setIsCropModalOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setError(null);
      setSuccessMsg(null);
    } else {
      setIsCropModalOpen(false);
    }
  }, [isOpen, initialMode]);

  if (!isOpen) return null;

  const signupPwdStatus = evaluatePasswordStrength(password, username, gmail);
  const resetPwdStatus = evaluatePasswordStrength(newPassword, identifier, identifier);

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value;
    if (!val.startsWith('@')) {
      val = `@${val.replace(/@/g, '')}`;
    }
    const cleaned = '@' + val.substring(1).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
    setUsername(cleaned);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    if (!identifier.trim()) {
      setError('Enter your @username or Gmail address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }
    setIsLoading(true);

    try {
      const res = await api.login(
        identifier.trim(),
        password,
        needsMfa || mfaCode ? mfaCode : undefined
      );
      setNeedsMfa(false);
      setMfaCode('');
      setPassword('');
      onAuthSuccess(res.profile, `Welcome back, ${res.profile.name}`);
      onClose();
    } catch (err: any) {
      triggerHaptic('error');
      if (err?.mfaRequired || (typeof err?.message === 'string' && err.message.includes('MFA_REQUIRED'))) {
        setNeedsMfa(true);
        setError('Two-factor authentication is enabled for this account. Enter your 6-digit authenticator code below.');
      } else {
        setError(err.message || 'Invalid email/username or password.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    const cleanGmail = gmail.trim().toLowerCase();
    const localPart = cleanGmail.split('@')[0] || '';
    if (
      !GMAIL_REGEX.test(cleanGmail) ||
      localPart.startsWith('.') ||
      localPart.endsWith('.') ||
      localPart.includes('..')
    ) {
      setError('Please enter a valid Gmail address (e.g. yourname@gmail.com).');
      return;
    }
    if (!USERNAME_REGEX.test(username) || username.length < 3 || username.length > 25) {
      setError('Username must start with @, contain only letters/numbers/underscores, and be 3 to 25 characters long.');
      return;
    }
    if (!signupPwdStatus.valid) {
      setError(signupPwdStatus.error || 'Password does not meet security requirements.');
      return;
    }
    if (!acceptTerms) {
      setError('Please accept the Terms of Service and Community Guidelines (17+/18+) to create an account.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.register({
        identifier: cleanGmail,
        email: cleanGmail,
        username,
        password,
        acceptTerms: true,
        name: displayName.trim() || undefined,
        avatarDataUrl: pendingAvatar?.dataUrl,
        avatarThumbnailDataUrl: pendingAvatar?.thumbnailDataUrl,
      });

      setPassword('');
      setPendingAvatar(null);
      setPendingProfile(res.profile);
      setSuccessMsg(`Account created for ${res.profile.handle}! Enter your 6-digit verification code or verify later.`);
      setMode('verifyEmail');
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Registration failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(verifyCodeInput.trim())) {
      setError('Enter the 6-digit numeric verification code.');
      return;
    }
    setIsLoading(true);
    try {
      await api.verifyAccount(verifyCodeInput.trim());
      setVerifyCodeInput('');
      if (pendingProfile) {
        const finalized = { ...pendingProfile, verified: true };
        setPendingProfile(null);
        onAuthSuccess(finalized, `Welcome to Schoolbackdoor, ${finalized.handle}!`);
      }
      onClose();
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Verification failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const res = await api.resendVerificationCode();
      setSuccessMsg(res.message || 'A fresh verification code has been prepared.');
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Could not resend verification code.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSkipVerification = () => {
    if (pendingProfile) {
      const finalized = pendingProfile;
      setPendingProfile(null);
      onAuthSuccess(finalized, `Welcome to Schoolbackdoor, ${finalized.handle}!`);
    }
    onClose();
  };

  const handleModalClose = () => {
    if (mode === 'verifyEmail' && pendingProfile) {
      const finalized = pendingProfile;
      setPendingProfile(null);
      onAuthSuccess(finalized, `Welcome to Schoolbackdoor, ${finalized.handle}!`);
    }
    onClose();
  };

  const handleRequestPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    if (!identifier.trim()) {
      setError('Enter your registered @username or Gmail address.');
      return;
    }
    setIsLoading(true);

    try {
      const res = await api.forgotPassword(identifier.trim());
      setSuccessMsg(res.message || 'If an account matches, recovery instructions have been prepared.');
      setMode('reset');
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Password recovery failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(resetCode.trim())) {
      setError('Enter a valid 6-digit recovery code.');
      return;
    }
    if (!resetPwdStatus.valid) {
      setError(resetPwdStatus.error || 'New password does not meet security requirements.');
      return;
    }
    setIsLoading(true);

    try {
      const res = await api.resetPassword(resetCode.trim(), newPassword, identifier.trim() || undefined);
      setSuccessMsg(res.message || 'Password updated successfully. Please sign in.');
      setMode('login');
      setPassword('');
      setNewPassword('');
      setResetCode('');
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Failed to reset password.');
    } finally {
      setIsLoading(false);
    }
  };

  const modalTitle =
    mode === 'login'
      ? 'Welcome Back'
      : mode === 'register'
      ? 'Create Account'
      : mode === 'verifyEmail'
      ? 'Verify Your Gmail'
      : mode === 'forgot'
      ? 'Recover Your Account'
      : 'Reset Your Password';

  const activeTabId = mode === 'reset' ? 'forgot' : mode;

  return (
    <>
      <GlassModal
        isOpen={isOpen}
        onClose={handleModalClose}
        maxWidthClass="max-w-md"
        title={modalTitle}
        subtitle="Schoolbackdoor · Independent Student Social Platform"
      >
      <div className="p-5 md:p-6 space-y-4">
        <div className="flex flex-col items-center text-center pb-1">
          <div className="text-[#171613] dark:text-[#F5EFE3]">
            <SchoolbackdoorLogo variant="dark" size="lg" />
          </div>
          <div className="font-serif font-bold text-lg text-[#171613] dark:text-[#F5EFE3] mt-1">
            Schoolbackdoor
          </div>
          <p className="text-xs text-[#82796F] dark:text-[#A89F95]">
            {mode === 'login'
              ? 'Sign in with your @username or Gmail address'
              : mode === 'register'
              ? 'Quick signup with a unique @username and Gmail — 100% free'
              : mode === 'verifyEmail'
              ? 'Verify your Gmail address to earn a verified badge'
              : 'Reset your password safely'}
          </p>
        </div>

        {mode !== 'verifyEmail' && (
          <GlassTab
            items={[
              { id: 'login', label: 'Log In', icon: <LogIn className="w-3.5 h-3.5" /> },
              { id: 'register', label: 'Sign Up', icon: <UserPlus className="w-3.5 h-3.5" /> },
              { id: 'forgot', label: 'Forgot Password', icon: <KeyRound className="w-3.5 h-3.5" /> },
            ]}
            activeId={activeTabId}
            onChange={(next) => {
              triggerHaptic('tap');
              setMode(next as 'login' | 'register' | 'forgot');
              setError(null);
              setSuccessMsg(null);
            }}
            className="w-full justify-center"
          />
        )}

        {error && (
          <div
            role="alert"
            className="p-3 rounded-xl bg-[#F6E2E6] dark:bg-[#4A2532]/70 border border-[#D98BA5]/60 dark:border-[#D98BA5]/45 text-[#171613] dark:text-[#F5EFE3] text-xs flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="p-3 rounded-xl bg-[#E8DDCC]/75 dark:bg-[#23211C] border border-[#171613]/15 dark:border-white/15 text-[#171613] dark:text-[#F5EFE3] text-xs flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-[#171613] dark:text-[#D98BA5] shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        {mode === 'login' && (
          <form onSubmit={handleLogin} className="space-y-3.5">
            <GlassInput
              label="@Username or Gmail"
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="@username or name@gmail.com"
              leftIcon={<Mail className="w-4 h-4" />}
            />

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-semibold tracking-wide text-[#82796F] dark:text-[#A89F95] uppercase">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setMode('forgot');
                    setError(null);
                    setSuccessMsg(null);
                  }}
                  className="text-[11px] font-semibold text-[#171613] dark:text-[#F5EFE3] hover:text-[#C4718E] dark:hover:text-[#E5A4BA] transition-colors cursor-pointer"
                >
                  Forgot password?
                </button>
              </div>
              <GlassInput
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                leftIcon={<Lock className="w-4 h-4" />}
                rightSlot={
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setShowPassword((v) => !v);
                    }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="p-1.5 rounded-lg text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                }
              />
            </div>

            {needsMfa && (
              <GlassInput
                label="Authenticator 6-Digit MFA Code"
                type="text"
                required
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                leftIcon={<KeyRound className="w-4 h-4" />}
                className="font-mono tracking-widest"
              />
            )}

            <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] bg-[#E8DDCC]/45 dark:bg-white/5 px-3.5 py-2.5 rounded-xl flex items-center gap-2 border border-transparent dark:border-white/8">
              <ShieldCheck className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" />
              <span>Independent student social platform — connect freely with friends and classmates.</span>
            </div>

            <GlassButton
              type="submit"
              variant="pink"
              size="lg"
              disabled={isLoading}
              className="w-full"
            >
              {isLoading ? 'Signing in...' : 'Log In'}
            </GlassButton>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={handleRegister} className="space-y-3">
            <div className="flex items-center justify-between gap-3 p-3 rounded-2xl glass-subtle border border-[#171613]/10 dark:border-white/10">
              <div className="flex items-center gap-3 min-w-0">
                <UserAvatar
                  name={displayName || username.replace(/^@/, '') || 'SB'}
                  initials={(displayName || username.replace(/^@/, '') || 'SB').slice(0, 2).toUpperCase()}
                  avatarUrl={pendingAvatar?.dataUrl}
                  avatarThumbUrl={pendingAvatar?.thumbnailDataUrl}
                  size="lg"
                  className="ring-2 ring-[#FFFCF7] dark:ring-[#23211C]"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#171613] dark:text-[#F5EFE3]">
                    Profile Picture (Optional)
                  </div>
                  <div className="text-[11px] text-[#82796F] dark:text-[#A89F95] truncate">
                    {IMAGE_UPLOAD_GUIDANCE}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setIsCropModalOpen(true);
                  }}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl glass-pink text-[#171613] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>{pendingAvatar ? 'Edit' : 'Add photo'}</span>
                </button>
                {pendingAvatar && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('close');
                      setPendingAvatar(null);
                    }}
                    aria-label="Remove selected profile picture"
                    className="min-h-[38px] min-w-[38px] rounded-xl glass-subtle text-[#82796F] hover:text-[#C4718E] flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            <GlassInput
              label="Unique Username (Starts with @, 3-25 chars)"
              type="text"
              autoComplete="username"
              required
              maxLength={25}
              value={username}
              onChange={handleUsernameChange}
              placeholder="@ade_student"
              leftIcon={<User className="w-4 h-4" />}
              className="font-mono"
            />

            <GlassInput
              label="Gmail Address"
              type="email"
              autoComplete="email"
              required
              value={gmail}
              onChange={(e) => setGmail(e.target.value)}
              placeholder="yourname@gmail.com"
              leftIcon={<Mail className="w-4 h-4" />}
            />

            <GlassInput
              label="Display Name (Optional)"
              type="text"
              maxLength={60}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How friends see your name"
            />

            <div>
              <GlassInput
                label="Strong Password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8+ chars: A-Z, a-z, 0-9, symbol"
                leftIcon={<Lock className="w-4 h-4" />}
                rightSlot={
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setShowPassword((v) => !v);
                    }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="p-1.5 rounded-lg text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                }
              />
              {password.length > 0 && (
                <div className="grid grid-cols-2 gap-1.5 mt-2 px-1">
                  {signupPwdStatus.checks.map((item) => (
                    <div
                      key={item.label}
                      className={`text-[11px] flex items-center gap-1.5 ${
                        item.met
                          ? 'text-[#171613] dark:text-[#E5A4BA] font-medium'
                          : 'text-[#82796F] dark:text-[#A89F95]'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          item.met ? 'bg-[#C4718E] dark:bg-[#E5A4BA]' : 'bg-[#82796F]/40'
                        }`}
                      />
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-xl glass-subtle border border-[#171613]/10 dark:border-white/10 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                required
                className="mt-0.5 w-4 h-4 accent-[#D98BA5] shrink-0 cursor-pointer"
              />
              <span className="text-[11px] text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                I confirm I am at least <strong>17+ / 18+</strong> years old and agree to the{' '}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline text-[#C4718E] dark:text-[#E5A4BA]"
                >
                  Terms &amp; Community Guidelines
                </a>{' '}
                and{' '}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline text-[#C4718E] dark:text-[#E5A4BA]"
                >
                  Privacy Policy
                </a>{' '}
                (zero tolerance for harassment, doxxing, or abusive content).
              </span>
            </label>

            <GlassButton
              type="submit"
              variant="pink"
              size="lg"
              disabled={isLoading || !acceptTerms}
              className="w-full mt-1"
            >
              {isLoading ? 'Creating Account...' : 'Create Free Account'}
            </GlassButton>
          </form>
        )}

        {mode === 'verifyEmail' && (
          <form onSubmit={handleVerifyEmail} className="space-y-3.5">
            <GlassInput
              label="6-Digit Verification Code"
              type="text"
              required
              maxLength={6}
              value={verifyCodeInput}
              onChange={(e) => setVerifyCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              leftIcon={<KeyRound className="w-4 h-4" />}
              className="font-mono tracking-widest"
            />
            <GlassButton type="submit" variant="pink" size="lg" disabled={isLoading} className="w-full">
              {isLoading ? 'Verifying...' : 'Verify Gmail & Continue'}
            </GlassButton>
            <div className="flex items-center justify-between text-xs pt-1">
              <button
                type="button"
                disabled={isLoading}
                onClick={handleResendVerification}
                className="font-semibold text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer min-h-[36px]"
              >
                Resend code
              </button>
              <button
                type="button"
                onClick={handleSkipVerification}
                className="text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer min-h-[36px]"
              >
                Verify later →
              </button>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleRequestPasswordReset} className="space-y-3.5">
            <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
              Enter your registered @username or Gmail address to prepare a 6-digit password reset code.
            </p>
            <GlassInput
              label="@Username or Gmail"
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="@username or yourname@gmail.com"
              leftIcon={<Mail className="w-4 h-4" />}
            />
            <GlassButton type="submit" variant="black" size="lg" disabled={isLoading} className="w-full">
              {isLoading ? 'Sending instructions...' : 'Request Recovery Code'}
            </GlassButton>
            <div className="flex items-center justify-between text-xs pt-1">
              <button
                type="button"
                onClick={() => {
                  setMode('reset');
                  setError(null);
                }}
                className="font-semibold text-[#C4718E] dark:text-[#E5A4BA] hover:text-[#171613] dark:hover:text-[#F5EFE3] py-1.5 cursor-pointer"
              >
                Already have a code?
              </button>
              <button
                type="button"
                onClick={() => setMode('login')}
                className="text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] py-1.5 cursor-pointer"
              >
                Back to Log In
              </button>
            </div>
          </form>
        )}

        {mode === 'reset' && (
          <form onSubmit={handleConfirmReset} className="space-y-3.5">
            <p className="text-xs text-[#82796F] dark:text-[#A89F95]">
              Enter your 6-digit recovery code and choose a strong new password.
            </p>
            <GlassInput
              label="6-Digit Recovery Code"
              type="text"
              required
              maxLength={6}
              value={resetCode}
              onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              leftIcon={<KeyRound className="w-4 h-4" />}
              className="font-mono tracking-widest"
            />
            <div>
              <GlassInput
                label="New Strong Password"
                type={showNewPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="8+ chars: A-Z, a-z, 0-9, symbol"
                leftIcon={<Lock className="w-4 h-4" />}
                rightSlot={
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setShowNewPassword((v) => !v);
                    }}
                    aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                    className="p-1.5 rounded-lg text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                  >
                    {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                }
              />
              {newPassword.length > 0 && (
                <div className="grid grid-cols-2 gap-1.5 mt-2 px-1">
                  {resetPwdStatus.checks.map((item) => (
                    <div
                      key={item.label}
                      className={`text-[11px] flex items-center gap-1.5 ${
                        item.met
                          ? 'text-[#171613] dark:text-[#E5A4BA] font-medium'
                          : 'text-[#82796F] dark:text-[#A89F95]'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          item.met ? 'bg-[#C4718E] dark:bg-[#E5A4BA]' : 'bg-[#82796F]/40'
                        }`}
                      />
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <GlassButton type="submit" variant="pink" size="lg" disabled={isLoading} className="w-full">
              {isLoading ? 'Updating Password...' : 'Set New Password'}
            </GlassButton>
            <button
              type="button"
              onClick={() => setMode('login')}
              className="w-full text-xs text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] py-2 cursor-pointer"
            >
              Back to Log In
            </button>
          </form>
        )}
      </div>
    </GlassModal>

      <AvatarCropModal
        isOpen={isCropModalOpen}
        currentAvatarUrl={pendingAvatar?.dataUrl}
        currentAvatarThumbUrl={pendingAvatar?.thumbnailDataUrl}
        userName={displayName || username}
        initials={(displayName || username.replace(/^@/, '') || 'SB').slice(0, 2).toUpperCase()}
        title="Add Profile Picture"
        onClose={() => setIsCropModalOpen(false)}
        onSave={async (cropped, onProgress) => {
          onProgress(100);
          setPendingAvatar({
            dataUrl: cropped.dataUrl,
            thumbnailDataUrl: cropped.thumbnailDataUrl,
          });
        }}
        onRemove={
          pendingAvatar
            ? async () => {
                setPendingAvatar(null);
              }
            : undefined
        }
      />
    </>
  );
};
