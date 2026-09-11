/**
 * @file Visual provider setup panel for the Ink TUI (opencode palette-style).
 * @description Arrow-navigated provider list, masked key field, inline
 * reachability probe, optional model pick — no chat Q&A. The plain `--plain`
 * loop keeps the `/connect` text wizard (see `connect.ts`); this panel is the
 * fullscreen equivalent. Key material never leaves the secret field except
 * into `saveProviderKey` (auth.json).
 */
import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { isProviderEnabled, type ProviderEntry } from '../providers.js'
import { DEFAULT_BASE_URL } from '../session.js'
import {
  normalizeBaseUrl,
  testConnection,
  type ConnectSession,
  type TestConnectionFn,
} from '../connect.js'
import { ACCENT, BODY, LineInput, MUTED, PanelFrame, SelectedRow } from './palette.js'

export interface ConnectPanelInitial {
  ref?: string
  key?: string
  baseURL?: string
}

type Step = 'pick' | 'id' | 'base' | 'key' | 'testing' | 'models' | 'done'

function isNewIdShape(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ref.trim())
}

export function ConnectPanel({ session, initial = {}, testConnection: testFnProp, notify, warn, onClose }: {
  session: ConnectSession
  initial?: ConnectPanelInitial
  testConnection?: TestConnectionFn
  notify: (line: string) => void
  warn: (line: string) => void
  onClose: () => void
}): React.JSX.Element {
  const testFn = testFnProp ?? testConnection
  const [step, setStep] = useState<Step>(() => {
    if (initial.ref && session.findProvider(initial.ref)) return initial.key ? 'testing' : 'key'
    if (initial.ref && isNewIdShape(initial.ref)) return initial.baseURL ? 'key' : 'base'
    return 'pick'
  })
  const [entry, setEntry] = useState<ProviderEntry | null>(() => {
    if (initial.ref) {
      const found = session.findProvider(initial.ref)
      if (found) return found
      if (isNewIdShape(initial.ref)) {
        return initial.baseURL
          ? { id: initial.ref.trim(), baseURL: normalizeBaseUrl(initial.baseURL) }
          : { id: initial.ref.trim() }
      }
    }
    return null
  })
  const [isNew, setIsNew] = useState<boolean>(() => {
    if (!initial.ref) return false
    return !session.findProvider(initial.ref) && isNewIdShape(initial.ref)
  })
  const [field, setField] = useState('')
  const [keyToSave, setKeyToSave] = useState<string | null>(initial.key?.trim() || null)
  const [probe, setProbe] = useState<{ ok: boolean; models: string[]; error?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(0)
  const [modelIndex, setModelIndex] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  // Recomputed every render (roster mutates in place on add/remove).
  const enabled = session.listProviders().entries.filter(isProviderEnabled)
  const rows = (() => {
    const needle = filter.trim().toLowerCase()
    const providers = needle
      ? enabled.filter((candidate) => `${candidate.id} ${candidate.name ?? ''}`.toLowerCase().includes(needle))
      : enabled
    return [...providers.map((candidate) => ({ kind: 'provider' as const, entry: candidate })), { kind: 'add' as const }]
  })()
  const selected = Math.min(index, Math.max(0, rows.length - 1))

  const fail = (message: string): void => setError(message)

  const submitKey = (value: string): void => {
    if (!entry) return
    const trimmed = value.trim()
    if (!trimmed && !session.keySourceFor(entry.id) && !keyToSave) {
      fail('a key is required (Esc back).')
      return
    }
    setError(null)
    if (trimmed) setKeyToSave(trimmed)
    setStep('testing')
  }

  // Reachability probe + activation. Failures warn but never roll back.
  useEffect(() => {
    if (step !== 'testing' || !entry) return
    let cancelled = false
    void (async () => {
      const current = entry
      let active = current
      try {
        if (isNew || initial.baseURL?.trim()) {
          active = initial.baseURL?.trim()
            ? { ...current, baseURL: normalizeBaseUrl(initial.baseURL) }
            : current.baseURL
              ? current
              : { ...current, baseURL: DEFAULT_BASE_URL }
          session.upsertProvider(active)
          if (!cancelled) {
            setEntry(active)
            notify(`provider saved: ${active.id}${active.baseURL ? ` (${active.baseURL})` : ''}`)
          }
        }
        const stash = keyToSave
        if (stash) {
          session.saveProviderKey(current.id, stash)
          if (!cancelled) {
            notify(session.getAuthPath()
              ? `key saved to auth.json for "${current.id}" (never shown again).`
              : 'key kept for this run only (no auth file — restart loses it).')
          }
        }
        session.setProvider(current.id)
      } catch (thrown) {
        if (!cancelled) {
          warn(thrown instanceof Error ? thrown.message : String(thrown))
          setStep('pick')
        }
        return
      }
      const probeKey = keyToSave || session.getApiKey()
      if (!probeKey) {
        if (!cancelled) {
          warn(`janus: no key for "${active.id}" — set one later with /connect ${active.id}.`)
          setStep('done')
        }
        return
      }
      const result = await testFn(active.baseURL ?? DEFAULT_BASE_URL, probeKey)
      if (cancelled) return
      setProbe(result)
      if (result.ok) {
        notify(`reachable · ${result.models.length} model(s) listed.`)
        const openWorld = !active.models || active.models.length === 0
        setStep(result.models.length > 0 && openWorld ? 'models' : 'done')
      } else {
        warn(`connection test failed: ${result.error ?? 'unknown error'} (setup saved; check baseURL/key).`)
        setStep('done')
      }
    })()
    return () => { cancelled = true }
    // Runs once per entry into the testing step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Summary lands in the discussion exactly once per completion.
  useEffect(() => {
    if (step !== 'done' || !entry) return
    const source = session.getApiKeySource()
    notify(`connected: ${entry.id} · model ${session.getModelId() ?? '(none — pick with /model)'} · key ${source ? `via ${source}` : 'missing'}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  useInput((input, key) => {
    if (step === 'testing') return
    if (key.escape) {
      if (pendingDelete) {
        setPendingDelete(null)
        return
      }
      if (step === 'pick' || step === 'done') onClose()
      else if (step === 'models') setStep('done')
      else setStep('pick')
      setError(null)
      return
    }
    if (step === 'done' && key.return) {
      onClose()
      return
    }
    if (step === 'pick') {
      if (key.upArrow) {
        setPendingDelete(null)
        setIndex((current) => (current - 1 + rows.length) % Math.max(1, rows.length))
        return
      }
      if (key.downArrow) {
        setPendingDelete(null)
        setIndex((current) => (current + 1) % Math.max(1, rows.length))
        return
      }
      if (key.return) {
        if (pendingDelete) {
          try {
            const removed = session.removeProvider(pendingDelete)
            notify(`provider removed: ${removed.id}${removed.removedKey ? ' (key cleared from auth.json)' : ''}`)
          } catch (thrown) {
            warn(thrown instanceof Error ? thrown.message : String(thrown))
          }
          setPendingDelete(null)
          setIndex(0)
          return
        }
        const row = rows[selected]
        if (!row) return
        if (row.kind === 'add') {
          setField('')
          setError(null)
          setStep('id')
          return
        }
        setEntry(row.entry)
        setIsNew(false)
        setField('')
        setError(null)
        setStep(initial.key ? 'testing' : 'key')
        if (initial.key) setKeyToSave(initial.key.trim())
        return
      }
      if (key.backspace || key.delete) {
        // Delete on an empty filter arms removal of the highlighted row;
        // otherwise it edits the filter text.
        if (key.delete && !filter && !pendingDelete) {
          const row = rows[selected]
          if (row && row.kind === 'provider') {
            setPendingDelete(row.entry.id)
            return
          }
        }
        setPendingDelete(null)
        setFilter((current) => current.slice(0, -1))
        setIndex(0)
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (!input || input.includes('\n') || input.includes('\r')) return
      setPendingDelete(null)
      setFilter((current) => current + input)
      setIndex(0)
      return
    }
    if (step === 'models') {
      const models = probe?.models ?? []
      if (key.upArrow) {
        setModelIndex((current) => (current - 1 + models.length) % Math.max(1, models.length))
        return
      }
      if (key.downArrow) {
        setModelIndex((current) => (current + 1) % Math.max(1, models.length))
        return
      }
      if (key.return) {
        const picked = models[Math.min(modelIndex, Math.max(0, models.length - 1))]
        if (picked) {
          try {
            session.setModel(picked)
            notify(`model switched: ${picked}`)
          } catch (thrown) {
            fail(thrown instanceof Error ? thrown.message : String(thrown))
            return
          }
        }
        setStep('done')
      }
    }
  }, { isActive: true })

  const storedSource = entry ? session.keySourceFor(entry.id) : null
  const keySource = storedSource ?? (keyToSave ? 'new key' : null)

  return (
    <PanelFrame
      title="◇ connect provider"
      hint={step === 'testing'
        ? 'testing…'
        : pendingDelete
          ? `delete “${pendingDelete}”? Enter=yes Esc=no`
          : '↑↓ move · Enter confirm · Del remove · Esc back/close'}
    >
      {step === 'pick' ? (
        <Box flexDirection="column">
          <Text>
            <Text color={MUTED}>› </Text>
            <Text color={BODY}>{filter}</Text>
            <Text backgroundColor={MUTED} color="black"> </Text>
          </Text>
          {rows.map((row, rowIndex) => {
            const active = rowIndex === selected
            if (row.kind === 'add') {
              const label = '+ Add new provider…'
              return active
                ? <SelectedRow key="add" text={label} width={60} />
                : <Text key="add" color={ACCENT}>{label}</Text>
            }
            if (pendingDelete === row.entry.id) {
              return <Text key={row.entry.id} color="red">{`✘ delete “${row.entry.id}” (+ its auth.json key)? Enter=yes Esc=no`}</Text>
            }
            const source = session.keySourceFor(row.entry.id)
            const label = `${row.entry.id}${row.entry.name ? ` (${row.entry.name})` : ''}  ${source ? 'key ✓' : 'key ✗'}`
            return active
              ? <SelectedRow key={row.entry.id} text={label} width={60} />
              : <Text key={row.entry.id} color={BODY}>{label}</Text>
          })}
        </Box>
      ) : null}

      {step === 'id' ? (
        <Box flexDirection="column">
          <Text color={BODY}>new provider id:</Text>
          <LineInput
            value={field}
            onChange={setField}
            onSubmit={(value) => {
              if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.trim())) {
                fail('id must match [A-Za-z0-9_-].')
                return
              }
              setError(null)
              setEntry({ id: value.trim() })
              setIsNew(true)
              setField('')
              setStep('base')
            }}
            onCancel={() => setStep('pick')}
          />
        </Box>
      ) : null}

      {step === 'base' && entry ? (
        <Box flexDirection="column">
          <Text color={BODY}>baseURL for “{entry.id}” (empty = {DEFAULT_BASE_URL}):</Text>
          <LineInput
            value={field}
            onChange={setField}
            onSubmit={(value) => {
              setError(null)
              setEntry({ ...entry, baseURL: value.trim() ? normalizeBaseUrl(value) : DEFAULT_BASE_URL })
              setField('')
              setStep(keyToSave ? 'testing' : 'key')
            }}
            onCancel={() => setStep('pick')}
          />
        </Box>
      ) : null}

      {step === 'key' && entry ? (
        <Box flexDirection="column">
          <Text color={BODY}>
            API key for “{entry.id}”{keySource ? ` (empty = keep via ${keySource})` : ''}:
          </Text>
          <LineInput
            value={field}
            onChange={setField}
            onSubmit={submitKey}
            onCancel={() => setStep('pick')}
            secret
          />
        </Box>
      ) : null}

      {step === 'testing' ? <Text color={MUTED}>probing /models …</Text> : null}

      {step === 'models' ? (
        <Box flexDirection="column">
          <Text color={BODY}>reachable — pick a model (Esc keeps current):</Text>
          {(probe?.models ?? []).slice(0, 20).map((model, rowIndex) => (
            rowIndex === Math.min(modelIndex, Math.max(0, (probe?.models.length ?? 1) - 1))
              ? <SelectedRow key={model} text={model} width={60} />
              : <Text key={model} color={BODY}>{model}</Text>
          ))}
        </Box>
      ) : null}

      {step === 'done' && entry ? (
        <Box flexDirection="column">
          <Text color={BODY}>
            ✓ {entry.id} · model {session.getModelId() ?? '(none)'} · key {session.getApiKeySource() ? `via ${session.getApiKeySource()}` : 'missing'}
          </Text>
          <Text color={MUTED}>Enter closes.</Text>
        </Box>
      ) : null}

      {error ? <Text color="red">✘ {error}</Text> : null}
    </PanelFrame>
  )
}
