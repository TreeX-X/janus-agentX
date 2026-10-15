import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applyHarnessInit, previewHarnessInit } from '../src/init.js'
import { NoteChatEditor } from '../src/note-editor.js'
import { NoteService } from '../src/note-service.js'

const fixtures: Array<{ root: string; service: NoteService }> = []
afterEach(async () => {
  for (const { root, service } of fixtures.splice(0)) {
    service.unwatchAll()
    await rm(root, { recursive: true, force: true })
  }
})
async function setup() {
  const root = await mkdtemp(join(realpathSync.native(tmpdir()), 'note-page-'))
  const service = new NoteService()
  fixtures.push({ root, service })
  await applyHarnessInit(await previewHarnessInit(root))
  const editor = new NoteChatEditor(service)
  const uri = (await editor.list(root, '')).notes[0].uri
  const file = join(root, '.agents/notes/module.md')
  const original = await readFile(file, 'utf8')
  await writeFile(file, original + '\n' + 'Long design detail\n'.repeat(100))
  return { root, editor, uri, file }
}

it('continues at the exact offset and same source hash', async () => {
  const f = await setup()
  const first = await f.editor.readPage(f.root, f.uri, { maxChars: 500 })
  const second = await f.editor.readPage(f.root, f.uri, { offset: first.nextOffset, maxChars: 500, expectedHash: first.expectedHash })
  expect(first.markdown + second.markdown).toBe((await readFile(f.file, 'utf8')).slice(0, 1000))
  expect(second.expectedHash).toBe(first.expectedHash)
})

it('a changed continuation cannot authorize writes using either the old or rejected new version', async () => {
  const f = await setup()
  const first = await f.editor.readPage(f.root, f.uri, { maxChars: 500 })
  await writeFile(f.file, await readFile(f.file, 'utf8') + '\nExternal change\n')
  await expect(f.editor.readPage(f.root, f.uri, { offset: first.nextOffset, expectedHash: first.expectedHash })).rejects.toThrow('CONFLICT')
  const service = fixtures.at(-1)!.service
  const current = await service.readNote(f.root, f.uri)
  const update = (expectedHash: string, callId: string) => f.editor.write(f.root, 'test', callId,
    { reason: 'Refine design', operations: [{ type: 'update', uri: f.uri, expectedHash, sections: { Design: 'Refined design.' } }] }, true, new AbortController().signal)
  await expect(update(first.expectedHash, 'old')).rejects.toThrow('Read the Note')
  await expect(update(current.sha256, 'rejected-new')).rejects.toThrow('Read the Note')
  const restarted = await f.editor.readPage(f.root, f.uri)
  expect((await update(restarted.expectedHash, 'restart'))?.files).toHaveLength(1)
})

it('an out-of-range page does not grant a remembered read for writing', async () => {
  const f = await setup()
  await expect(f.editor.readPage(f.root, f.uri, { offset: 1000000 })).rejects.toThrow('Offset')
  const source = await fixtures.at(-1)!.service.readNote(f.root, f.uri)
  await expect(f.editor.write(f.root, 'test', 'invalid-page', { reason: 'Update design',
    operations: [{ type: 'update', uri: f.uri, expectedHash: source.sha256, sections: { Design: 'Refined design.' } }] }, true, new AbortController().signal)).rejects.toThrow('Read the Note')
})
