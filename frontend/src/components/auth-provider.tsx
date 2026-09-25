import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { authApi } from '@/api/auth'
import { ApiError, AUTH_UNAUTHORIZED_EVENT } from '@/api/client'
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context'
import { SessionExpiredDialog } from './session-expired-dialog'
import type { AuthUser } from '@/types'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'

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

  const logoutMutation = useMutation({
    mutationFn: authApi.logout,
    onSettled: async () => {
      queryClient.setQueryData<AuthUser | null>(AUTH_QUERY_KEY, null)
      clearProtectedQueries(queryClient)
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY })
    },
  })

  useEffect(() => {
    const handleUnauthorized = () => {
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

  let status: AuthStatus = 'loading'
  if (expiredUser) {
    status = 'authenticated'
  } else if (meQuery.isError) {
    status = meQuery.error instanceof ApiError && meQuery.error.status === 401
      ? 'anonymous'
      : 'error'
  } else if (meQuery.isSuccess) {
    status = meQuery.data ? 'authenticated' : 'anonymous'
  }

  const value: AuthContextValue = {
    user: expiredUser ?? meQuery.data ?? null,
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
      {expiredUser && (
        <SessionExpiredDialog
          user={expiredUser}
          onSignedIn={handleSignedInAgain}
          onSignOut={handleExpiredSignOut}
        />
      )}
    </AuthContext.Provider>
  )
}
