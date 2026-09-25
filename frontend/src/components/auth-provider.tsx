import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { authApi } from '@/api/auth'
import { ApiError, AUTH_UNAUTHORIZED_EVENT } from '@/api/client'
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context'
import type { AuthUser } from '@/types'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
// Eager on purpose: the dialog exists to keep an unsaved page alive, and a lazy
// chunk that failed to load after a deploy would reload that page away.
import { SessionExpiredDialog } from './session-expired-dialog'

const AUTH_QUERY_KEY = ['auth', 'me'] as const

function clearProtectedQueries(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: query => query.queryKey[0] !== 'auth',
  })
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const meQuery = useQuery<AuthUser | null, Error>({
    meta: SILENT_ERROR_META,
    queryKey: AUTH_QUERY_KEY,
    queryFn: authApi.me,
    retry: false,
    staleTime: 60_000,
  })
  // The account whose session ran out while the app was open. While set, the
  // shell stays mounted as that user under a sign-in dialog instead of
  // redirecting to /auth and throwing away unsaved input (SHELL-15).
  const [expiredUser, setExpiredUser] = useState<AuthUser | null>(null)
  // Requests still in flight when the user signs out answer 401 once the
  // cookie is gone; that is the sign-out working, not a session running out.
  const loggingOutRef = useRef(false)

  const logoutMutation = useMutation({
    mutationFn: authApi.logout,
    onMutate: () => {
      loggingOutRef.current = true
    },
    onSettled: async () => {
      loggingOutRef.current = false
      setExpiredUser(null)
      queryClient.setQueryData<AuthUser | null>(AUTH_QUERY_KEY, null)
      clearProtectedQueries(queryClient)
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY })
    },
  })

  useEffect(() => {
    const handleUnauthorized = () => {
      if (loggingOutRef.current) return
      const current = queryClient.getQueryData<AuthUser | null>(AUTH_QUERY_KEY)
      if (current) {
        setExpiredUser((held) => held ?? current)
        return
      }
      queryClient.setQueryData<AuthUser | null>(AUTH_QUERY_KEY, null)
      clearProtectedQueries(queryClient)
      void queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY })
    }

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized)
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized)
  }, [queryClient])

  const handleSignedInAgain = (user: AuthUser) => {
    queryClient.setQueryData<AuthUser | null>(AUTH_QUERY_KEY, user)
    setExpiredUser(null)
    // Whatever failed while the session was gone asks again.
    void queryClient.invalidateQueries({ predicate: query => query.queryKey[0] !== 'auth' })
  }

  const handleExpiredSignOut = () => {
    setExpiredUser(null)
    queryClient.setQueryData<AuthUser | null>(AUTH_QUERY_KEY, null)
    clearProtectedQueries(queryClient)
  }

  // /auth paths never raise the unauthorized event, so a 401 on the /auth/me
  // refetch (reconnect after a laptop sleep) arrives here instead. With a user
  // already known it is the same expiry as a 401 anywhere else: react-query
  // keeps that user as the query's data, and the dialog signs them back in
  // rather than the routes redirecting to /auth and dropping the page.
  const meExpired = meQuery.isError
    && meQuery.error instanceof ApiError
    && meQuery.error.status === 401
    && !logoutMutation.isPending
  const heldUser = expiredUser ?? (meExpired ? meQuery.data ?? null : null)

  let status: AuthStatus = 'loading'
  if (heldUser) {
    status = 'authenticated'
  } else if (meQuery.isError) {
    status = meQuery.error instanceof ApiError && meQuery.error.status === 401
      ? 'anonymous'
      : 'error'
  } else if (meQuery.isSuccess) {
    status = meQuery.data ? 'authenticated' : 'anonymous'
  }

  const value: AuthContextValue = {
    user: heldUser ?? meQuery.data ?? null,
    status,
    error: status === 'error' ? meQuery.error : null,
    isLoggingOut: logoutMutation.isPending,
    logout: async () => {
      await logoutMutation.mutateAsync()
    },
    refresh: () => {
      void meQuery.refetch()
    },
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
      {heldUser && (
        <SessionExpiredDialog
          user={heldUser}
          onSignedIn={handleSignedInAgain}
          onSignOut={handleExpiredSignOut}
        />
      )}
    </AuthContext.Provider>
  )
}
