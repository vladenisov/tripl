import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, LockKeyhole, Radar, UserPlus } from 'lucide-react'
import { authApi } from '@/api/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HINT } from '@/lib/passwordPolicy'
import type { AuthUser } from '@/types'

type AuthMode = 'login' | 'register' | 'forgot' | 'reset'

const CARD_COPY: Record<AuthMode, { title: string; description: string }> = {
  login: {
    title: 'Sign in to tripl',
    description: 'Use your account to access the workspace and monitoring tools.',
  },
  register: {
    title: 'Create your tripl account',
    description:
      'Set up your account to start tracking coverage, monitoring drift, and routing alerts.',
  },
  forgot: {
    title: 'Reset your password',
    description: 'Enter your account email and we will send you a reset link.',
  },
  reset: {
    title: 'Choose a new password',
    description: 'Set a new password to finish resetting your account.',
  },
}

export default function AuthPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  // A reset link lands on /auth?reset_token=... (the SPA has no dedicated reset
  // route), so an incoming token puts the page straight into reset mode.
  const resetToken = searchParams.get('reset_token') ?? ''
  const [chosenMode, setChosenMode] = useState<AuthMode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const destination = (
    location.state as { from?: { pathname?: string } } | null
  )?.from?.pathname ?? '/'

  // Unauthenticated instance probe: drives the "first account becomes owner"
  // note and whether a sign-up form is worth offering at all.
  const statusQuery = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: authApi.status,
  })
  const isFreshInstance = statusQuery.data?.has_users === false
  // Only a definite `false` closes the door in the UI. While the probe is in
  // flight (or if it failed) we keep offering sign-up — the server is the real
  // gate and still answers 403; guessing "closed" here would hide the form on
  // an open instance every time the page loads.
  const registrationClosed = statusQuery.data?.registration_enabled === false
  // A live reset token always forces reset mode: a reset link must show the reset
  // form even when /auth was ALREADY mounted (same route, new ?reset_token=, no
  // remount). Deriving `mode` — rather than syncing it in an effect — means the
  // token can never be missed and avoids set-state-in-effect. The same derivation
  // falls back to login if the probe resolves "closed" while register mode is
  // already showing (the tab is hidden, but the mode is state that predates it).
  const mode: AuthMode = resetToken
    ? 'reset'
    : registrationClosed && chosenMode === 'register'
      ? 'login'
      : chosenMode

  const authMutation = useMutation({
    mutationFn: () =>
      mode === 'login'
        ? authApi.login({ email, password })
        : authApi.register({
            email,
            password,
            ...(name.trim() ? { name: name.trim() } : {}),
          }),
    onSuccess: async (user: AuthUser) => {
      queryClient.setQueryData<AuthUser | null>(['auth', 'me'], user)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate(destination, { replace: true })
    },
  })

  const forgotMutation = useMutation({
    mutationFn: () => authApi.requestPasswordReset({ email }),
  })

  const resetMutation = useMutation({
    mutationFn: () =>
      authApi.confirmPasswordReset({ token: resetToken, new_password: newPassword }),
  })

  function switchMode(next: AuthMode) {
    setChosenMode(next)
    authMutation.reset()
    forgotMutation.reset()
    resetMutation.reset()
    // Drop any ?reset_token= when leaving reset mode so a refresh doesn't drop
    // the user back into a stale reset form.
    if (next !== 'reset' && searchParams.has('reset_token')) {
      setSearchParams({}, { replace: true })
    }
  }

  const isAuthTab = mode === 'login' || mode === 'register'
  const submitLabel =
    mode === 'login'
      ? 'Sign In'
      : mode === 'register'
        ? 'Create your account'
        : mode === 'forgot'
          ? 'Send reset link'
          : 'Set new password'
  const { title: cardTitle, description: cardDescription } = CARD_COPY[mode]

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(20,184,166,0.15),_transparent_32%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.94))] text-slate-50">
      <div className="mx-auto grid min-h-screen max-w-6xl items-center gap-8 px-6 py-10 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="space-y-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.28em] text-teal-200/80">
            <Radar className="h-3.5 w-3.5" />
            Tracking Operations
          </div>
          <div className="max-w-2xl space-y-4">
            <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Operate the tracking plan before the data drifts.
            </h1>
            <p className="max-w-xl text-base leading-7 text-slate-300">
              Sign in to manage catalog coverage, scan production data, review anomalies,
              and route alerts without losing the operational context of the workspace.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FeatureCard
              eyebrow="Catalog"
              title="Track intent"
              description="Keep event definitions, variables, and metadata aligned with the real implementation surface."
            />
            <FeatureCard
              eyebrow="Monitoring"
              title="Catch drift"
              description="Surface the latest scan outcomes and anomaly signals as soon as collection diverges."
            />
            <FeatureCard
              eyebrow="Alerting"
              title="Route action"
              description="Move from suspicious metrics to Slack and Telegram delivery without leaving the product."
            />
          </div>
        </section>

        <Card className="border-white/10 bg-slate-950/70 py-0 shadow-2xl shadow-teal-950/40 backdrop-blur">
          <CardHeader className="border-b border-white/10 px-6 py-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle as="h2" className="text-2xl text-white">{cardTitle}</CardTitle>
                <CardDescription className="mt-2 text-slate-400">
                  {cardDescription}
                </CardDescription>
              </div>
              <div className="rounded-full border border-teal-400/30 bg-teal-400/10 p-2 text-teal-200">
                {mode === 'register' ? (
                  <UserPlus className="h-4 w-4" />
                ) : (
                  <LockKeyhole className="h-4 w-4" />
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 px-6 py-6">
            {isAuthTab && !registrationClosed && (
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-white/5 p-1">
                <button
                  type="button"
                  aria-pressed={mode === 'login'}
                  className={cn(
                    'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    mode === 'login'
                      ? 'bg-white text-slate-950 shadow-sm'
                      : 'text-slate-300 hover:text-white',
                  )}
                  onClick={() => switchMode('login')}
                >
                  Existing Account
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'register'}
                  className={cn(
                    'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    mode === 'register'
                      ? 'bg-white text-slate-950 shadow-sm'
                      : 'text-slate-300 hover:text-white',
                  )}
                  onClick={() => switchMode('register')}
                >
                  Create account
                </button>
              </div>
            )}

            {isAuthTab && (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  authMutation.mutate()
                }}
              >
                {mode === 'register' && (
                  <div className="space-y-2">
                    <Label htmlFor="auth-name" className="text-slate-200">
                      Name
                    </Label>
                    <Input
                      id="auth-name"
                      value={name}
                      onChange={event => setName(event.target.value)}
                      placeholder="Analytics owner"
                      className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="auth-email" className="text-slate-200">
                    Email
                  </Label>
                  <Input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    required
                    className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="auth-password" className="text-slate-200">
                    Password
                  </Label>
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    placeholder={mode === 'register' ? PASSWORD_POLICY_HINT : 'Enter your password'}
                    required
                    // Register enforces the shared policy; login stays lenient so
                    // pre-policy accounts can still sign in.
                    minLength={mode === 'register' ? PASSWORD_MIN_LENGTH : 1}
                    aria-describedby={mode === 'register' ? 'auth-password-hint' : undefined}
                    className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                  />
                  {mode === 'register' && (
                    <p id="auth-password-hint" className="text-xs leading-5 text-slate-400">
                      {PASSWORD_POLICY_HINT}
                    </p>
                  )}
                </div>

                {mode === 'register' && isFreshInstance && (
                  <p className="rounded-lg border border-teal-400/20 bg-teal-400/5 px-3 py-2 text-sm leading-6 text-teal-100/90">
                    The first account on a new instance becomes the owner and can manage
                    members and instance settings.
                  </p>
                )}

                {authMutation.isError && (
                  <div
                    role="alert"
                    className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
                  >
                    {authMutation.error.message}
                  </div>
                )}

                <Button
                  type="submit"
                  size="lg"
                  className="w-full justify-center bg-teal-400 text-slate-950 hover:bg-teal-300"
                  disabled={authMutation.isPending}
                >
                  {authMutation.isPending ? 'Working…' : submitLabel}
                  {!authMutation.isPending && <ArrowRight className="h-4 w-4" />}
                </Button>
              </form>
            )}

            {mode === 'forgot' &&
              (forgotMutation.isSuccess ? (
                <div className="space-y-4">
                  <div
                    role="status"
                    className="rounded-lg border border-teal-400/20 bg-teal-400/5 px-3 py-3 text-sm leading-6 text-teal-100/90"
                  >
                    {forgotMutation.data?.email_configured
                      ? 'If an account exists for that email, a password reset link is on its way. The link expires in one hour.'
                      : 'Self-service password reset is not available on this instance. Contact your instance owner to reset your password.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="text-sm font-medium text-teal-300 underline-offset-4 hover:underline"
                  >
                    Back to sign in
                  </button>
                </div>
              ) : (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    forgotMutation.mutate()
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="forgot-email" className="text-slate-200">
                      Email
                    </Label>
                    <Input
                      id="forgot-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={event => setEmail(event.target.value)}
                      placeholder="you@company.com"
                      required
                      className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                    />
                  </div>

                  {forgotMutation.isError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
                    >
                      {forgotMutation.error.message}
                    </div>
                  )}

                  <Button
                    type="submit"
                    size="lg"
                    className="w-full justify-center bg-teal-400 text-slate-950 hover:bg-teal-300"
                    disabled={forgotMutation.isPending}
                  >
                    {forgotMutation.isPending ? 'Working…' : submitLabel}
                    {!forgotMutation.isPending && <ArrowRight className="h-4 w-4" />}
                  </Button>

                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="text-sm font-medium text-teal-300 underline-offset-4 hover:underline"
                  >
                    Back to sign in
                  </button>
                </form>
              ))}

            {mode === 'reset' &&
              (resetMutation.isSuccess ? (
                <div className="space-y-4">
                  <div
                    role="status"
                    className="rounded-lg border border-teal-400/20 bg-teal-400/5 px-3 py-3 text-sm leading-6 text-teal-100/90"
                  >
                    Your password has been reset. Sign in with your new password to continue.
                  </div>
                  <Button
                    type="button"
                    size="lg"
                    className="w-full justify-center bg-teal-400 text-slate-950 hover:bg-teal-300"
                    onClick={() => switchMode('login')}
                  >
                    Back to sign in
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    resetMutation.mutate()
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="reset-password" className="text-slate-200">
                      New password
                    </Label>
                    <Input
                      id="reset-password"
                      type="password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={event => setNewPassword(event.target.value)}
                      placeholder={PASSWORD_POLICY_HINT}
                      required
                      minLength={PASSWORD_MIN_LENGTH}
                      aria-describedby="reset-password-hint"
                      className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                    />
                    <p id="reset-password-hint" className="text-xs leading-5 text-slate-400">
                      {PASSWORD_POLICY_HINT}
                    </p>
                  </div>

                  {resetMutation.isError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
                    >
                      {resetMutation.error.message}
                    </div>
                  )}

                  <Button
                    type="submit"
                    size="lg"
                    className="w-full justify-center bg-teal-400 text-slate-950 hover:bg-teal-300"
                    disabled={resetMutation.isPending}
                  >
                    {resetMutation.isPending ? 'Working…' : submitLabel}
                    {!resetMutation.isPending && <ArrowRight className="h-4 w-4" />}
                  </Button>

                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="text-sm font-medium text-teal-300 underline-offset-4 hover:underline"
                  >
                    Back to sign in
                  </button>
                </form>
              ))}

            {mode === 'login' && registrationClosed && (
              <p
                role="status"
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm leading-6 text-slate-300"
              >
                Sign-ups are closed on this instance. Ask an owner to reopen registration
                under Settings → Instance → Security &amp; access so you can sign up.
              </p>
            )}

            {mode === 'login' && (
              <div className="space-y-2 text-sm leading-6 text-slate-400">
                <p>Use the same account across catalog, monitoring, and alerting workflows.</p>
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="font-medium text-teal-300 underline-offset-4 hover:underline"
                >
                  Forgot your password?
                </button>
              </div>
            )}

            {mode === 'register' && (
              <p className="text-sm leading-6 text-slate-400">
                New accounts are created inside this tripl workspace and receive access immediately.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function FeatureCard({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-teal-200/70">
        {eyebrow}
      </div>
      <div className="mt-3 text-lg font-semibold text-white">{title}</div>
      <p className="mt-2 text-sm leading-6 text-slate-300">{description}</p>
    </div>
  )
}
