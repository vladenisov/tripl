import {
  useEffect,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { authApi } from '@/api/auth'
import { ApiError, AUTH_UNAUTHORIZED_EVENT } from '@/api/client'
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context'
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
      queryClient.setQueryData<AuthUser | null>(AUTH_QUERY_KEY, null)
      clearProtectedQueries(queryClient)
      void queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY })
    }

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized)
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized)
  }, [queryClient])

  let status: AuthStatus = 'loading'
  if (meQuery.isError) {
    status = meQuery.error instanceof ApiError && meQuery.error.status === 401
      ? 'anonymous'
      : 'error'
  } else if (meQuery.isSuccess) {
    status = meQuery.data ? 'authenticated' : 'anonymous'
  }

  const value: AuthContextValue = {
    user: meQuery.data ?? null,
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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
