import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { cronAuthDenial } from '@/lib/security/cron-auth'
import { runKrakenCustodySync } from '@/lib/custody/kraken-sync'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const admin = createAdminClient()
  const { data: connections, error } = await (admin as any).from('custody_connections')
    .select('id').eq('active', true)
  if (error) return NextResponse.json({ ok: false, error: 'Could not load custody connections.' }, { status: 500 })

  const runs: Array<{ connectionId: string; ok: boolean; error?: string }> = []
  for (const connection of (connections ?? []) as Array<{ id: string }>) {
    try {
      const result = await runKrakenCustodySync(admin, connection.id)
      runs.push({ connectionId: connection.id, ok: !result.error, ...(result.error ? { error: result.error } : {}) })
    } catch {
      runs.push({ connectionId: connection.id, ok: false, error: 'Custody sync failed.' })
    }
  }
  const failed = runs.filter(run => !run.ok).length
  return NextResponse.json({
    ok: failed === 0,
    total: runs.length,
    succeeded: runs.length - failed,
    failed,
    runs,
  })
}

