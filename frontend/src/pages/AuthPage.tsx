import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, LockKeyhole, Radar, UserPlus } from 'lucide-react'
import { authApi } from '@/api/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { AuthUser } from '@/types'

type AuthMode = 'login' | 'register'

export default function AuthPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState<AuthMode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const destination = (
    location.state as { from?: { pathname?: string } } | null
  )?.from?.pathname ?? '/'

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

  const submitLabel = mode === 'login' ? 'Sign In' : 'Create Account'

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.15),_transparent_32%),linear-gradient(135deg,_rgba(15,23,42,0.98),_rgba(2,6,23,0.94))] text-slate-50">
      <div className="mx-auto grid min-h-screen max-w-6xl items-center gap-8 px-6 py-10 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="space-y-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.28em] text-sky-200/80">
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

        <Card className="border-white/10 bg-slate-950/70 py-0 shadow-2xl shadow-sky-950/40 backdrop-blur">
          <CardHeader className="border-b border-white/10 px-6 py-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle as="h2" className="text-2xl text-white">Sign in to tripl</CardTitle>
                <CardDescription className="mt-2 text-slate-400">
                  Use your account to access the workspace and monitoring tools.
                </CardDescription>
              </div>
              <div className="rounded-full border border-sky-400/30 bg-sky-400/10 p-2 text-sky-200">
                {mode === 'login' ? (
                  <LockKeyhole className="h-4 w-4" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 px-6 py-6">
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
                onClick={() => setMode('login')}
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
                onClick={() => setMode('register')}
              >
                Create Account
              </button>
            </div>

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
                  placeholder="Minimum 8 characters"
                  required
                  minLength={8}
                  className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                />
              </div>

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
                className="w-full justify-center bg-sky-400 text-slate-950 hover:bg-sky-300"
                disabled={authMutation.isPending}
              >
                {authMutation.isPending ? 'Working…' : submitLabel}
                {!authMutation.isPending && <ArrowRight className="h-4 w-4" />}
              </Button>
            </form>

            <p className="text-sm leading-6 text-slate-400">
              {mode === 'login'
                ? 'Use the same account across catalog, monitoring, and alerting workflows.'
                : 'New accounts are created inside this tripl workspace and receive access immediately.'}
            </p>
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
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-200/70">
        {eyebrow}
      </div>
      <div className="mt-3 text-lg font-semibold text-white">{title}</div>
      <p className="mt-2 text-sm leading-6 text-slate-300">{description}</p>
    </div>
  )
}
