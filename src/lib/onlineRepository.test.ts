import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureAnonymousLearnerSession, getPublishedWorksheetJoinErrorMessage, listResponseRows, listSubmittedResponseRows, loadPublishedWorksheet, PublishedWorksheetLoadError, saveOnlineResponse, uniqueSubmittedResponseRows, type OnlineResponseRow } from './onlineRepository'
import { requireSupabase } from './supabase'
import type { WorksheetResponse } from './types'

vi.mock('./supabase', () => ({
  requireSupabase: vi.fn(),
}))

const mockClient = {
  auth: {
    getSession: vi.fn(),
    signOut: vi.fn(),
    signInAnonymously: vi.fn(),
  },
  from: vi.fn(),
}

function createSelectBuilder(data: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  }
  return builder
}

function createUpsertBuilder(data: unknown) {
  const builder = {
    upsert: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn(async () => ({ data, error: null })),
  }
  return builder
}

const responseDocument: WorksheetResponse = {
  responseSchema: 'interactive-worksheet-response',
  schemaVersion: 1,
  worksheetId: 'worksheet-definition',
  worksheetVersion: 1,
  responseId: 'local-response',
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
  responses: { answer: 'Learner answer' },
}

describe('online worksheet repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads published worksheets through the code-gated RPC', async () => {
    const workbook = {
      id: 'worksheet-id',
      owner_id: 'teacher-id',
      public_code: 'ABC12345',
      title: 'Shared workbook',
      definition: { id: 'worksheet', version: 1, title: 'Shared workbook', pages: [] },
      status: 'published',
      created_at: '2026-10-03T00:00:00.000Z',
      updated_at: '2026-10-03T00:00:00.000Z',
    }
    const single = vi.fn().mockResolvedValue({ data: workbook, error: null })
    const rpc = vi.fn().mockReturnValue({ single })
    const from = vi.fn()

    vi.mocked(requireSupabase).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'learner-id', is_anonymous: true } } } }),
      },
      rpc,
      from,
    } as any)

    await expect(loadPublishedWorksheet(' abc12345 ')).resolves.toBe(workbook)

    expect(rpc).toHaveBeenCalledWith('get_published_worksheet_by_code', { lookup_public_code: 'ABC12345' })
    expect(single).toHaveBeenCalledTimes(1)
    expect(from).not.toHaveBeenCalled()
  })

  it('falls back to the legacy published-row lookup when the RPC is not installed', async () => {
    const workbook = {
      id: 'worksheet-id',
      public_code: 'ABC12345',
      status: 'published',
      definition: { id: 'worksheet', version: 1, title: 'Shared workbook', pages: [] },
    }
    const rpcSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.get_published_worksheet_by_code in the schema cache' },
    })
    const legacyBuilder = {
      select: vi.fn(() => legacyBuilder),
      eq: vi.fn(() => legacyBuilder),
      single: vi.fn().mockResolvedValue({ data: workbook, error: null }),
    }
    const from = vi.fn().mockReturnValue(legacyBuilder)

    vi.mocked(requireSupabase).mockReturnValue({
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'learner-id', is_anonymous: true } } } }) },
      rpc: vi.fn().mockReturnValue({ single: rpcSingle }),
      from,
    } as any)

    await expect(loadPublishedWorksheet(' abc12345 ')).resolves.toBe(workbook)
    expect(from).toHaveBeenCalledWith('worksheets')
    expect(legacyBuilder.eq).toHaveBeenNthCalledWith(1, 'public_code', 'ABC12345')
    expect(legacyBuilder.eq).toHaveBeenNthCalledWith(2, 'status', 'published')
  })

  it('does not downgrade to the legacy lookup for unrelated RPC failures', async () => {
    const from = vi.fn()
    vi.mocked(requireSupabase).mockReturnValue({
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'learner-id', is_anonymous: true } } } }) },
      rpc: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } }) }),
      from,
    } as any)

    await expect(loadPublishedWorksheet('ABC12345')).rejects.toMatchObject({ kind: 'authentication' })
    expect(from).not.toHaveBeenCalled()
  })

  it('distinguishes invalid codes from service and connection failures', () => {
    expect(getPublishedWorksheetJoinErrorMessage(new PublishedWorksheetLoadError('not-found', 'missing'))).toContain('could not find')
    expect(getPublishedWorksheetJoinErrorMessage(new PublishedWorksheetLoadError('configuration', 'migration missing'))).toContain('needs an update')
    expect(getPublishedWorksheetJoinErrorMessage(new TypeError('Failed to fetch'))).toContain('connection')
  })
})

describe('online response persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireSupabase).mockReturnValue(mockClient as any)
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'learner-1', is_anonymous: true } } },
    })
    mockClient.auth.signOut.mockResolvedValue({ error: null })
  })

  it('does not upsert over an already-submitted response', async () => {
    const submittedRow = {
      id: 'response-1',
      worksheet_id: 'online-worksheet',
      participant_id: 'learner-1',
      answers: responseDocument,
      status: 'submitted',
    }
    const selectBuilder = createSelectBuilder(submittedRow)
    mockClient.from.mockReturnValue(selectBuilder)

    await expect(saveOnlineResponse('online-worksheet', responseDocument)).resolves.toBe(submittedRow)

    expect(mockClient.from).toHaveBeenCalledTimes(1)
    expect(selectBuilder.eq).toHaveBeenCalledWith('participant_id', 'learner-1')
  })

  it('keeps draft saves as draft upserts', async () => {
    const savedDraftRow = {
      id: 'response-1',
      worksheet_id: 'online-worksheet',
      participant_id: 'learner-1',
      answers: responseDocument,
      status: 'draft',
    }
    const selectBuilder = createSelectBuilder(savedDraftRow)
    const upsertBuilder = createUpsertBuilder(savedDraftRow)
    mockClient.from.mockReturnValueOnce(selectBuilder).mockReturnValueOnce(upsertBuilder)

    await expect(saveOnlineResponse('online-worksheet', responseDocument, ' Group 1 ')).resolves.toBe(savedDraftRow)

    expect(upsertBuilder.upsert).toHaveBeenCalledWith(expect.objectContaining({
      participant_id: 'learner-1',
      participant_label: 'Group 1',
      status: 'draft',
    }), { onConflict: 'worksheet_id,participant_id' })
  })
})

describe('anonymous learner sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireSupabase).mockReturnValue(mockClient as any)
    mockClient.auth.signOut.mockResolvedValue({ error: null })
  })

  it('reuses an existing anonymous learner session', async () => {
    const session = { user: { id: 'learner-1', is_anonymous: true } }
    mockClient.auth.getSession.mockResolvedValue({ data: { session } })

    await expect(ensureAnonymousLearnerSession()).resolves.toBe(session)
    expect(mockClient.auth.signOut).not.toHaveBeenCalled()
    expect(mockClient.auth.signInAnonymously).not.toHaveBeenCalled()
  })

  it('replaces a signed-in teacher session before joining as a learner', async () => {
    const learnerSession = { user: { id: 'learner-2', is_anonymous: true } }
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'teacher-1', is_anonymous: false } } },
    })
    mockClient.auth.signInAnonymously.mockResolvedValue({ data: { session: learnerSession }, error: null })

    await expect(ensureAnonymousLearnerSession()).resolves.toBe(learnerSession)
    expect(mockClient.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(mockClient.auth.signInAnonymously).toHaveBeenCalledOnce()
  })
})

function createRow(id: string, responseId = id): OnlineResponseRow {
  return {
    id,
    worksheet_id: 'worksheet-1',
    participant_id: `participant-${id}`,
    participant_label: null,
    answers: {
      responseSchema: 'interactive-worksheet-response',
      schemaVersion: 1,
      worksheetId: 'worksheet-1',
      worksheetVersion: 1,
      responseId,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      responses: {},
    },
    status: 'submitted',
    created_at: '2026-10-03T00:00:00.000Z',
    updated_at: '2026-10-03T00:00:00.000Z',
    submitted_at: '2026-10-03T00:00:00.000Z',
  }
}

describe('online repository submitted responses', () => {
  it('pages through every submitted response row', async () => {
    const pages = [
      Array.from({ length: 1000 }, (_value, index) => createRow(`row-${index}`)),
      [createRow('row-1000'), createRow('row-1001')],
    ]
    const ranges: Array<[number, number]> = []
    const client = {
      from: vi.fn(() => {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          order: vi.fn(() => builder),
          range: vi.fn(async (from: number, to: number) => {
            ranges.push([from, to])
            return { data: pages.shift() || [], error: null }
          }),
        }
        return builder
      }),
    }
    vi.mocked(requireSupabase).mockReturnValue(client as any)

    const rows = await listSubmittedResponseRows('worksheet-1')

    expect(rows).toHaveLength(1002)
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
  })

  it('loads draft and submitted rows for the teacher activity view', async () => {
    const draft = createRow('draft-row')
    draft.status = 'draft'
    draft.submitted_at = null
    const submitted = createRow('submitted-row')
    const client = {
      from: vi.fn(() => {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          order: vi.fn(() => builder),
          range: vi.fn().mockResolvedValue({ data: [draft, submitted], error: null }),
        }
        return builder
      }),
    }
    vi.mocked(requireSupabase).mockReturnValue(client as any)

    const rows = await listResponseRows('worksheet-1')

    expect(rows).toEqual([draft, submitted])
    expect(client.from).toHaveBeenCalledWith('responses')
  })

  it('keeps the newest row when online answers reuse a response id', () => {
    const newerDuplicate = createRow('db-newer', 'response-1')
    const olderDuplicate = createRow('db-older', 'response-1')
    const unique = createRow('db-unique', 'response-2')

    expect(uniqueSubmittedResponseRows([newerDuplicate, olderDuplicate, unique])).toEqual([
      newerDuplicate,
      unique,
    ])
  })
})
