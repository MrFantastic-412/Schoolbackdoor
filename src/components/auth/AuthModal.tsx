import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Lock,
  LogIn,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  User,
  UserPlus,
} from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api } from '../../api/client';
import { StudentProfile } from '../../types';
import { GlassButton, GlassInput, GlassModal, GlassTab } from '../glass';
import { SchoolbackdoorLogo } from '../glass/SchoolbackdoorLogo';
import { UserAvatar } from '../common/UserAvatar';
import { AvatarCropModal } from '../profile/AvatarCropModal';
import { IMAGE_UPLOAD_GUIDANCE } from '../../utils/imageCompression';
import { solvePowChallenge } from '../../utils/pow';
import { triggerHaptic } from '../../utils/haptics';
import { formatPasskeyError, isPasskeySupported } from '../../utils/webauthn';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: (profile: StudentProfile, message?: string) => void;
  initialMode?: 'login' | 'register' | 'forgot';
}

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

function evaluatePasswordStrength(pwd: string, username?: string) {
  const hasMinLen = pwd.length >= 8 && pwd.length <= 128;
  const hasUpper = /[A-Z]/.test(pwd);
  const hasLower = /[a-z]/.test(pwd);
  const hasNumber = /[0-9]/.test(pwd);
  const hasSymbol = /[^A-Za-z0-9\s]/.test(pwd);
  const isCommon = COMMON_WEAK_PASSWORDS.has(pwd.toLowerCase());
  const cleanUser = (username || '').replace(/^@/, '').trim().toLowerCase();
  const containsIdentity = cleanUser.length >= 4 && pwd.toLowerCase().includes(cleanUser);

  let error: string | null = null;
  if (!hasMinLen) error = 'Password must be between 8 and 128 characters.';
  else if (!hasUpper) error = 'Include at least one uppercase letter.';
  else if (!hasLower) error = 'Include at least one lowercase letter.';
  else if (!hasNumber) error = 'Include at least one number.';
  else if (!hasSymbol) error = 'Include at least one symbol (e.g., !@#$%).';
  else if (isCommon) error = 'This password is too common. Choose a stronger combination.';
  else if (containsIdentity) error = 'Password cannot contain your username.';

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

export function downloadRecoveryCodesTxt(username: string, codes: string[]) {
  const cleanHandle = (username.startsWith('@') ? username : `@${username}`).trim();
  const content = [
    'SCHOOLBACKDOOR — SINGLE-USE RECOVERY CODES',
    `Account: ${cleanHandle}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'IMPORTANT:',
    '- Each code works ONCE to reset a forgotten password.',
    '- Keep this file offline or in a password manager. Anyone with a code and your username can reset your password.',
    '- Schoolbackdoor has no email, SMS, or manual admin bypass if you lose your password, passkey, and all unused recovery codes.',
    '',
    ...codes.map((code, i) => `${String(i + 1).padStart(2, '0')}. ${code}`),
    '',
  ].join('\n');

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `schoolbackdoor-recovery-codes-${cleanHandle.replace(/[^a-zA-Z0-9_-]/g, '')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onAuthSuccess,
  initialMode = 'login',
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'recoveryCodes'>(initialMode);
  const [loginUsername, setLoginUsername] = useState('');
  const [username, setUsername] = useState('@');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [honeypot, setHoneypot] = useState('');

  const [recoveryUsername, setRecoveryUsername] = useState('');
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [recoveryMethod, setRecoveryMethod] = useState<'code' | 'passkey'>('code');
  const [passkeyRecoveryToken, setPasskeyRecoveryToken] = useState<string | null>(null);
  const [passkeyRecoveryUser, setPasskeyRecoveryUser] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [isPasskeyBusy, setIsPasskeyBusy] = useState(false);
  const webauthnSupported = isPasskeySupported();

  const [pendingProfile, setPendingProfile] = useState<StudentProfile | null>(null);
  const [issuedRecoveryCodes, setIssuedRecoveryCodes] = useState<string[]>([]);
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [savedCodesConfirmed, setSavedCodesConfirmed] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [pendingAvatar, setPendingAvatar] = useState<{
    dataUrl: string;
    thumbnailDataUrl: string;
  } | null>(null);
  const [isCropModalOpen, setIsCropModalOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [adminNeedsSetup, setAdminNeedsSetup] = useState(false);
  const [showAdminSetupForm, setShowAdminSetupForm] = useState(false);
  const [adminSetupPassword, setAdminSetupPassword] = useState('');
  const [adminSetupConfirm, setAdminSetupConfirm] = useState('');
  const isSubmittingRef = useRef(false);
  const regIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setError(null);
      setSuccessMsg(null);
      setIssuedRecoveryCodes([]);
      setCopiedCodes(false);
      setSavedCodesConfirmed(false);
      setPasskeyRecoveryToken(null);
      setPasskeyRecoveryUser(null);
      setIsPasskeyBusy(false);
      regIdempotencyKeyRef.current = null;
      setShowAdminSetupForm(false);
      setAdminSetupPassword('');
      setAdminSetupConfirm('');
      void api
        .getSetupStatus()
        .then((st) => setAdminNeedsSetup(Boolean(st?.adminNeedsSetup)))
        .catch(() => setAdminNeedsSetup(false));
    } else {
      setIsCropModalOpen(false);
      isSubmittingRef.current = false;
      setIsPasskeyBusy(false);
    }
  }, [isOpen, initialMode]);

  useEffect(() => {
    regIdempotencyKeyRef.current = null;
  }, [username, password, confirmPassword]);

  if (!isOpen) return null;

  const signupPwdStatus = evaluatePasswordStrength(password, username);
  const resetPwdStatus = evaluatePasswordStrength(newPassword, recoveryUsername);

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
    if (isSubmittingRef.current) return;
    setError(null);
    setSuccessMsg(null);
    if (!loginUsername.trim()) {
      setError('Enter your @username.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }
    isSubmittingRef.current = true;
    setIsLoading(true);

    try {
      const res = await api.login(
        loginUsername.trim(),
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
        setError(err.message || 'Invalid username or password.');
      }
    } finally {
      isSubmittingRef.current = false;
      setIsLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    if (isSubmittingRef.current || isPasskeyBusy) return;
    if (!webauthnSupported) {
      setError('Passkeys are not supported in this browser or context. Sign in with your @username and password above.');
      return;
    }
    setError(null);
    setSuccessMsg(null);
    isSubmittingRef.current = true;
    setIsPasskeyBusy(true);
    try {
      const options = await api.getPasskeyLoginOptions(loginUsername.trim() || undefined);
      const assertion = await startAuthentication({ optionsJSON: options });
      const res = await api.verifyPasskeyLogin(assertion);
      triggerHaptic('success');
      setPassword('');
      onAuthSuccess(res.profile, `Signed in with passkey as ${res.profile.name}`);
      onClose();
    } catch (err: any) {
      triggerHaptic('error');
      setError(formatPasskeyError(err, 'Passkey sign-in failed.'));
    } finally {
      isSubmittingRef.current = false;
      setIsPasskeyBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    setError(null);
    setSuccessMsg(null);

    if (!USERNAME_REGEX.test(username) || username.length < 3 || username.length > 25) {
      setError('Username must start with @, contain only letters/numbers/underscores, and be 3 to 25 characters long.');
      return;
    }
    if (!signupPwdStatus.valid) {
      setError(signupPwdStatus.error || 'Password does not meet security requirements.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Password and confirm password do not match.');
      return;
    }
    if (!acceptTerms) {
      setError('Please accept the Terms of Service and Community Guidelines (17+/18+) to create an account.');
      return;
    }

    if (!regIdempotencyKeyRef.current) {
      regIdempotencyKeyRef.current = `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    isSubmittingRef.current = true;
    setIsLoading(true);
    try {
      const challenge = await api.getBotChallenge();
      const solution = await solvePowChallenge(challenge.nonce, challenge.difficulty);

      const res = await api.register({
        username,
        password,
        confirmPassword,
        acceptTerms: true,
        idempotencyKey: regIdempotencyKeyRef.current,
        botChallengeId: challenge.challengeId,
        botChallengeNonce: challenge.nonce,
        botChallengeSolution: solution,
        honeypot,
        name: displayName.trim() || undefined,
        avatarDataUrl: pendingAvatar?.dataUrl,
        avatarThumbnailDataUrl: pendingAvatar?.thumbnailDataUrl,
      });

      setPassword('');
      setConfirmPassword('');
      setPendingAvatar(null);
      setPendingProfile(res.profile);
      setIssuedRecoveryCodes(Array.isArray(res.recoveryCodes) ? res.recoveryCodes : []);
      setCopiedCodes(false);
      setSavedCodesConfirmed(false);
      setSuccessMsg(`Account created for ${res.profile.handle}! Save these 10 single-use recovery codes now.`);
      setMode('recoveryCodes');
      triggerHaptic('success');
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Registration failed.');
    } finally {
      isSubmittingRef.current = false;
      setIsLoading(false);
    }
  };

  const handleCopyRecoveryCodes = async () => {
    if (!issuedRecoveryCodes.length) return;
    try {
      await navigator.clipboard.writeText(issuedRecoveryCodes.join('\n'));
      setCopiedCodes(true);
      triggerHaptic('success');
      setTimeout(() => setCopiedCodes(false), 2500);
    } catch {
      setError('Could not access clipboard automatically. Please use Download .txt or copy manually.');
    }
  };

  const handleFinishRecoveryCodes = () => {
    if (!savedCodesConfirmed) return;
    if (pendingProfile) {
      onAuthSuccess(pendingProfile, `Welcome to Schoolbackdoor, ${pendingProfile.handle}!`);
    }
    setIssuedRecoveryCodes([]);
    onClose();
  };

  const handleRecoveryReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    setError(null);
    setSuccessMsg(null);

    if (!recoveryUsername.trim() || !recoveryCodeInput.trim()) {
      setError('Enter your @username and one unused single-use recovery code.');
      return;
    }
    if (!resetPwdStatus.valid) {
      setError(resetPwdStatus.error || 'New password does not meet security requirements.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('New password and confirmation password do not match.');
      return;
    }

    isSubmittingRef.current = true;
    setIsLoading(true);
    try {
      const res = await api.resetPasswordWithRecoveryCode({
        username: recoveryUsername.trim(),
        recoveryCode: recoveryCodeInput.trim(),
        newPassword,
        confirmPassword: confirmNewPassword,
      });
      triggerHaptic('success');
      setSuccessMsg(res.message || 'Password updated. Sign in with your new password.');
      setLoginUsername(recoveryUsername.trim());
      setRecoveryCodeInput('');
      setNewPassword('');
      setConfirmNewPassword('');
      setPassword('');
      setMode('login');
    } catch (err: any) {
      triggerHaptic('error');
      setError(err.message || 'Unable to reset password.');
    } finally {
      isSubmittingRef.current = false;
      setIsLoading(false);
    }
  };

  const handleVerifyPasskeyForRecovery = async () => {
    if (isSubmittingRef.current || isPasskeyBusy) return;
    if (!webauthnSupported) {
      setError('Passkeys are not supported in this browser. Use a single-use recovery code instead.');
      return;
    }
    setError(null);
    setSuccessMsg(null);
    isSubmittingRef.current = true;
    setIsPasskeyBusy(true);
    try {
      const options = await api.getPasskeyRecoveryOptions(recoveryUsername.trim() || undefined);
      const assertion = await startAuthentication({ optionsJSON: options });
      const res = await api.verifyPasskeyRecovery(assertion);
      triggerHaptic('success');
      setPasskeyRecoveryToken(res.recoveryToken);
      setPasskeyRecoveryUser(res.username);
      setRecoveryUsername(res.username);
      setSuccessMsg(`Passkey verified for ${res.username}. Choose your new strong password below.`);
    } catch (err: any) {
      triggerHaptic('error');
      setError(formatPasskeyError(err, 'Could not verify your passkey.'));
    } finally {
      isSubmittingRef.current = false;
      setIsPasskeyBusy(false);
    }
  };

  const handlePasskeyRecoveryReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current || !passkeyRecoveryToken) return;
    setError(null);
    setSuccessMsg(null);

    const pwdStatus = evaluatePasswordStrength(newPassword, passkeyRecoveryUser || recoveryUsername);
    if (!pwdStatus.valid) {
      setError(pwdStatus.error || 'New password does not meet security requirements.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('New password and confirmation password do not match.');
      return;
    }

    isSubmittingRef.current = true;
    setIsLoading(true);
    try {
      const res = await api.resetPasswordWithPasskeyRecovery({
        recoveryToken: passkeyRecoveryToken,
        newPassword,
        confirmPassword: confirmNewPassword,
      });
      triggerHaptic('success');
      setPasskeyRecoveryToken(null);
      setPasskeyRecoveryUser(null);
      setNewPassword('');
      setConfirmNewPassword('');
      onAuthSuccess(res.profile, res.message || 'Password updated and other sessions signed out.');
      onClose();
    } catch (err: any) {
      triggerHaptic('error');
      setError(err?.message || 'Unable to reset password with passkey.');
    } finally {
      isSubmittingRef.current = false;
      setIsLoading(false);
    }
  };

  const handleClaimFirstRunAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    setError(null);
    setSuccessMsg(null);
    const pwdStatus = evaluatePasswordStrength(adminSetupPassword, '@THEBACKDOOR');
    if (!pwdStatus.valid) {
      setError(pwdStatus.error || 'Choose a stronger password.');
      return;
    }
    if (adminSetupPassword !== adminSetupConfirm) {
      setError('Password and confirmation password do not match.');
      return;
    }
    isSubmittingRef.current = true;
    setIsLoading(true);
    try {
      const res = await api.claimFirstRunAdmin(adminSetupPassword, adminSetupConfirm);
      triggerHaptic('success');
      setAdminSetupPassword('');
      setAdminSetupConfirm('');
      setAdminNeedsSetup(false);
      setShowAdminSetupForm(false);
      setPendingProfile(res.profile);
      setIssuedRecoveryCodes(Array.isArray(res.recoveryCodes) ? res.recoveryCodes : []);
      setCopiedCodes(false);
      setSavedCodesConfirmed(false);
      setSuccessMsg('Initial @THEBACKDOOR Admin password set. Save these 10 single-use recovery codes now.');
      setMode('recoveryCodes');
    } catch (err: any) {
      triggerHaptic('error');
      setError(err?.message || 'Unable to complete initial Admin setup.');
    } finally {
      isSubmittingRef.current = false;
      setIsLoading(false);
    }
  };

  const modalTitle =
    mode === 'login'
      ? 'Welcome Back'
      : mode === 'register'
      ? 'Create Account'
      : mode === 'recoveryCodes'
      ? 'Save Your Recovery Codes'
      : 'Recover Account Password';

  return (
    <>
      <GlassModal
        isOpen={isOpen}
        onClose={mode === 'recoveryCodes' && !savedCodesConfirmed ? () => {} : onClose}
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
                ? 'Sign in with your @username and password or passkey'
                : mode === 'register'
                ? 'Choose a unique @username — no email or phone number needed'
                : mode === 'recoveryCodes'
                ? 'Shown ONCE — required if you ever forget your password'
                : 'Reset your password with a single-use recovery code or passkey'}
            </p>
          </div>

          {mode !== 'recoveryCodes' && (
            <GlassTab
              items={[
                { id: 'login', label: 'Sign In', icon: <LogIn className="w-3.5 h-3.5" /> },
                { id: 'register', label: 'Create Account', icon: <UserPlus className="w-3.5 h-3.5" /> },
                { id: 'forgot', label: 'Recovery', icon: <KeyRound className="w-3.5 h-3.5" /> },
              ]}
              activeId={mode}
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
                label="@Username"
                type="text"
                autoComplete="username"
                required
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                placeholder="@username"
                leftIcon={<User className="w-4 h-4" />}
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
                      setRecoveryUsername(loginUsername);
                      setMode('forgot');
                      setError(null);
                      setSuccessMsg(null);
                    }}
                    className="text-[11px] font-semibold text-[#171613] dark:text-[#F5EFE3] hover:text-[#C4718E] dark:hover:text-[#E5A4BA] transition-colors cursor-pointer"
                  >
                    Forgot Password?
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
                <span>Private by design: zero email, phone number, or external messaging required.</span>
              </div>

              <GlassButton type="submit" variant="pink" size="lg" disabled={isLoading || isPasskeyBusy} className="w-full">
                {isLoading ? 'Signing in...' : 'Sign In'}
              </GlassButton>

              <div className="flex items-center gap-2.5 text-[11px] text-[#82796F] dark:text-[#A89F95]">
                <div className="h-px flex-1 bg-[#171613]/10 dark:bg-white/10" />
                <span className="font-mono uppercase tracking-wider">or</span>
                <div className="h-px flex-1 bg-[#171613]/10 dark:bg-white/10" />
              </div>

              <div className="space-y-1.5">
                <GlassButton
                  type="button"
                  variant="glass"
                  size="lg"
                  disabled={!webauthnSupported || isLoading || isPasskeyBusy}
                  onClick={handlePasskeyLogin}
                  className="w-full"
                >
                  <Fingerprint className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA]" />
                  <span>{isPasskeyBusy ? 'Waiting for Passkey...' : 'Sign in with Passkey'}</span>
                </GlassButton>
                <p className="text-[11px] text-center text-[#82796F] dark:text-[#A89F95]">
                  {webauthnSupported
                    ? 'Leave @username blank for discoverable passkeys, or enter it to filter.'
                    : 'Passkeys require HTTPS and a supported browser; password sign-in works everywhere.'}
                </p>
              </div>

              <div className="pt-1 flex items-center justify-center gap-1.5 text-xs text-[#82796F] dark:text-[#A89F95]">
                <span>New to Schoolbackdoor?</span>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setMode('register');
                    setError(null);
                    setSuccessMsg(null);
                  }}
                  className="font-semibold text-[#C4718E] dark:text-[#E5A4BA] hover:underline cursor-pointer"
                >
                  Create Account
                </button>
              </div>

              {adminNeedsSetup && (
                <div className="pt-2 border-t border-[#171613]/10 dark:border-white/10">
                  {!showAdminSetupForm ? (
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('tap');
                        setShowAdminSetupForm(true);
                        setError(null);
                      }}
                      className="w-full py-2 px-3 rounded-xl glass-subtle border border-[#D98BA5]/45 text-[11px] font-semibold text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/60 dark:hover:bg-[#4A2532]/50 transition-colors cursor-pointer"
                    >
                      First-Run Setup: Claim @THEBACKDOOR Admin Password
                    </button>
                  ) : (
                    <div className="p-3.5 rounded-xl glass-subtle border border-[#D98BA5]/55 space-y-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#171613] dark:text-[#F5EFE3]">
                          Set Initial @THEBACKDOOR Password
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowAdminSetupForm(false)}
                          className="text-[11px] underline text-[#82796F] cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                        Available once on a fresh installation with no <code className="font-mono">ADMIN_PASSWORD</code> set.
                      </p>
                      <GlassInput
                        label="New Admin Password"
                        type="password"
                        autoComplete="new-password"
                        value={adminSetupPassword}
                        onChange={(e) => setAdminSetupPassword(e.target.value)}
                        placeholder="8+ chars: A-Z, a-z, 0-9, symbol"
                        leftIcon={<Lock className="w-4 h-4" />}
                      />
                      <GlassInput
                        label="Confirm Admin Password"
                        type="password"
                        autoComplete="new-password"
                        value={adminSetupConfirm}
                        onChange={(e) => setAdminSetupConfirm(e.target.value)}
                        placeholder="Re-enter password"
                        leftIcon={<Lock className="w-4 h-4" />}
                      />
                      <GlassButton
                        type="button"
                        variant="black"
                        size="sm"
                        disabled={isLoading}
                        onClick={handleClaimFirstRunAdmin}
                        className="w-full"
                      >
                        {isLoading ? 'Provisioning Admin...' : 'Set Admin Password & Generate Recovery Codes'}
                      </GlassButton>
                    </div>
                  )}
                </div>
              )}
            </form>
          )}

          {mode === 'register' && (
            <form onSubmit={handleRegister} className="space-y-3">
              {/* Hidden honeypot field for automated bot filtering */}
              <div className="hidden" aria-hidden="true">
                <label htmlFor="sb-contact-site">Website</label>
                <input
                  id="sb-contact-site"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                />
              </div>

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
                label="Unique @Username (3-25 chars)"
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

              <GlassInput
                label="Confirm Password"
                type={showConfirmPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter your password"
                leftIcon={<Lock className="w-4 h-4" />}
                rightSlot={
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('tap');
                      setShowConfirmPassword((v) => !v);
                    }}
                    aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                    className="p-1.5 rounded-lg text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                }
              />

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
                {isLoading ? 'Securing & Creating Account...' : 'Create Free Account'}
              </GlassButton>
            </form>
          )}

          {mode === 'recoveryCodes' && (
            <div className="space-y-3.5">
              <div className="p-3 rounded-xl bg-[#F6E2E6]/75 dark:bg-[#4A2532]/55 border border-[#D98BA5]/60 text-[11px] text-[#171613] dark:text-[#F5EFE3] leading-relaxed flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-[#C4718E] dark:text-[#E5A4BA] shrink-0 mt-0.5" />
                <span>
                  These <strong>10 single-use recovery codes</strong> are shown <strong>only once</strong>. Each code can reset your password once. Keep them offline or in a password manager.
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 p-3 rounded-2xl glass-subtle border border-[#171613]/10 dark:border-white/10 font-mono text-xs">
                {issuedRecoveryCodes.map((code, idx) => (
                  <div
                    key={code}
                    className="px-2.5 py-1.5 rounded-lg bg-[#FFFCF7]/85 dark:bg-[#1E1C18] border border-[#171613]/8 dark:border-white/8 text-[#171613] dark:text-[#F5EFE3] flex items-center justify-between gap-1.5"
                  >
                    <span className="text-[10px] text-[#82796F] dark:text-[#A89F95]">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="font-semibold tracking-tight select-all">{code}</span>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <GlassButton type="button" variant="glass" size="sm" onClick={handleCopyRecoveryCodes}>
                  {copiedCodes ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedCodes ? 'Copied All' : 'Copy Codes'}</span>
                </GlassButton>
                <GlassButton
                  type="button"
                  variant="black"
                  size="sm"
                  onClick={() => {
                    downloadRecoveryCodesTxt(pendingProfile?.handle || username, issuedRecoveryCodes);
                    triggerHaptic('success');
                  }}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download .txt</span>
                </GlassButton>
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-xl glass-subtle border border-[#171613]/10 dark:border-white/10 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={savedCodesConfirmed}
                  onChange={(e) => setSavedCodesConfirmed(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-[#D98BA5] shrink-0 cursor-pointer"
                />
                <span className="text-[11px] text-[#171613]/85 dark:text-[#F5EFE3]/85 leading-relaxed">
                  I&apos;ve saved these 10 single-use recovery codes safely and understand they will not be displayed again.
                </span>
              </label>

              <GlassButton
                type="button"
                variant="pink"
                size="lg"
                disabled={!savedCodesConfirmed}
                onClick={handleFinishRecoveryCodes}
                className="w-full"
              >
                Continue to Schoolbackdoor
              </GlassButton>
            </div>
          )}

          {mode === 'forgot' && (
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-2 p-1 rounded-xl glass-subtle border border-[#171613]/10 dark:border-white/10">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setRecoveryMethod('code');
                    setError(null);
                    setSuccessMsg(null);
                  }}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    recoveryMethod === 'code'
                      ? 'bg-[#D98BA5] text-[#171613] shadow-xs'
                      : 'text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Recovery Code</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setRecoveryMethod('passkey');
                    setError(null);
                    setSuccessMsg(null);
                  }}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    recoveryMethod === 'passkey'
                      ? 'bg-[#D98BA5] text-[#171613] shadow-xs'
                      : 'text-[#82796F] dark:text-[#A89F95] hover:text-[#171613] dark:hover:text-[#F5EFE3]'
                  }`}
                >
                  <Fingerprint className="w-3.5 h-3.5" />
                  <span>Passkey</span>
                </button>
              </div>

              {recoveryMethod === 'code' ? (
                <form onSubmit={handleRecoveryReset} className="space-y-3">
                  <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                    Enter your <strong>@username</strong>, one unused <strong>single-use recovery code</strong>, and choose a strong new password.
                  </p>

                  <GlassInput
                    label="@Username"
                    type="text"
                    autoComplete="username"
                    required
                    value={recoveryUsername}
                    onChange={(e) => setRecoveryUsername(e.target.value)}
                    placeholder="@username"
                    leftIcon={<User className="w-4 h-4" />}
                    className="font-mono"
                  />

                  <GlassInput
                    label="Single-Use Recovery Code"
                    type="text"
                    required
                    maxLength={24}
                    value={recoveryCodeInput}
                    onChange={(e) => setRecoveryCodeInput(e.target.value.toUpperCase())}
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    leftIcon={<KeyRound className="w-4 h-4" />}
                    className="font-mono tracking-wider"
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

                  <GlassInput
                    label="Confirm New Password"
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Re-enter your new password"
                    leftIcon={<Lock className="w-4 h-4" />}
                  />

                  <GlassButton type="submit" variant="pink" size="lg" disabled={isLoading} className="w-full">
                    {isLoading ? 'Resetting Password...' : 'Reset Password'}
                  </GlassButton>
                </form>
              ) : !passkeyRecoveryToken ? (
                <div className="space-y-3">
                  <p className="text-xs text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                    Verify your identity with a saved <strong>passkey</strong> to set a new password and sign out other devices.
                  </p>

                  <GlassInput
                    label="@Username (Optional for discoverable passkeys)"
                    type="text"
                    autoComplete="username"
                    value={recoveryUsername}
                    onChange={(e) => setRecoveryUsername(e.target.value)}
                    placeholder="@username (leave blank if unsure)"
                    leftIcon={<User className="w-4 h-4" />}
                    className="font-mono"
                  />

                  <GlassButton
                    type="button"
                    variant="pink"
                    size="lg"
                    disabled={!webauthnSupported || isPasskeyBusy}
                    onClick={handleVerifyPasskeyForRecovery}
                    className="w-full"
                  >
                    <Fingerprint className="w-4 h-4" />
                    <span>{isPasskeyBusy ? 'Waiting for Passkey...' : 'Verify with Passkey'}</span>
                  </GlassButton>

                  {!webauthnSupported && (
                    <p className="text-[11px] text-[#82796F] dark:text-[#A89F95]">
                      Passkeys are not available in this browser or non-HTTPS context. Switch to Recovery Code above instead.
                    </p>
                  )}
                </div>
              ) : (
                <form onSubmit={handlePasskeyRecoveryReset} className="space-y-3">
                  <div className="p-2.5 rounded-xl glass-subtle border border-[#D98BA5]/50 text-xs text-[#171613] dark:text-[#F5EFE3] flex items-center justify-between gap-2">
                    <span>
                      Passkey verified for <strong className="font-mono">{passkeyRecoveryUser}</strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setPasskeyRecoveryToken(null);
                        setPasskeyRecoveryUser(null);
                        setError(null);
                        setSuccessMsg(null);
                      }}
                      className="text-[11px] underline text-[#C4718E] dark:text-[#E5A4BA] cursor-pointer"
                    >
                      Start over
                    </button>
                  </div>

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

                  <GlassInput
                    label="Confirm New Password"
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Re-enter your new password"
                    leftIcon={<Lock className="w-4 h-4" />}
                  />

                  <GlassButton type="submit" variant="pink" size="lg" disabled={isLoading} className="w-full">
                    {isLoading ? 'Saving Password...' : 'Set New Password & Sign In'}
                  </GlassButton>
                </form>
              )}

              <div className="p-3 rounded-xl glass-subtle border border-[#171613]/10 dark:border-white/10 text-[11px] text-[#82796F] dark:text-[#A89F95] leading-relaxed">
                <strong className="text-[#171613] dark:text-[#F5EFE3] block mb-0.5">
                  No password, passkey, or unused recovery codes left?
                </strong>
                Because Schoolbackdoor collects no email address or phone number, accounts without any remaining recovery method cannot be verified or recovered by support.
              </div>
            </div>
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
