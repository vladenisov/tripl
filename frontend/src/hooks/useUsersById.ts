import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usersApi } from '@/api/users'

/**
 * The workspace roster as `id -> display name`, for turning a stored `user_id`
 * into a person.
 *
 * Resolving client-side is the convention here rather than embedding a name in
 * every response: the id is already on the wire, and one shared `['users']`
 * query serves every caller on the page — react-query dedupes the fetch, so
 * three panels asking for it cost one request.
 *
 * `GET /users` is open to any authenticated user (`api/v1/users.py` says so in
 * as many words), so no caller needs a permission branch around it.
 */
export function useUsersById(): Map<string, string> {
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() })
  return useMemo(() => new Map((users ?? []).map((u) => [u.id, u.name ?? u.email])), [users])
}

/** The name behind a `user_id`, or `'unknown'` — for a deleted account, whose
 *  FK is SET NULL precisely so the row it wrote survives it. */
export function displayUser(
  usersById: Map<string, string>,
  userId: string | null | undefined,
): string {
  return (userId ? usersById.get(userId) : undefined) ?? 'unknown'
}
