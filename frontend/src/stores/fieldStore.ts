import { createStore } from 'zustand/vanilla'
import type { FieldIdentifyLog, FieldNote, FieldSporePrint } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface FieldState {
  notes: FieldNote[]
  spores: FieldSporePrint[]
  identifies: FieldIdentifyLog[]
  loaded: boolean
  hydrate: () => Promise<void>
  saveNote: (note: FieldNote) => Promise<void>
  removeNote: (id: string) => Promise<void>
  saveSpore: (spore: FieldSporePrint) => Promise<void>
  removeSpore: (id: string) => Promise<void>
  saveIdentify: (log: FieldIdentifyLog) => Promise<void>
  removeIdentify: (id: string) => Promise<void>
}

export const fieldStore = createStore<FieldState>((set, get) => ({
  notes: [],
  spores: [],
  identifies: [],
  loaded: false,
  hydrate: async () => {
    const [notes, spores, identifies] = await Promise.all([
      syncAll<FieldNote>(db.fieldNotes),
      syncAll<FieldSporePrint>(db.fieldSpores),
      syncAll<FieldIdentifyLog>(db.fieldIdentifies)
    ])
    notes.sort((a, b) => a.tempCode.localeCompare(b.tempCode, 'zh-Hans-CN'))
    spores.sort((a, b) => a.noteId.localeCompare(b.noteId) || a.observeDate.localeCompare(b.observeDate))
    identifies.sort((a, b) => b.date.localeCompare(a.date))
    set({ notes, spores, identifies, loaded: true })
  },
  saveNote: async (note) => {
    await syncPut<FieldNote>(db.fieldNotes, note)
    await get().hydrate()
  },
  removeNote: async (id) => {
    await db.transaction('rw', db.fieldNotes, db.fieldSpores, db.fieldIdentifies, async () => {
      await db.fieldSpores.where('noteId').equals(id).delete()
      await db.fieldIdentifies.where('noteId').equals(id).delete()
      await db.fieldNotes.delete(id)
    })
    await get().hydrate()
  },
  saveSpore: async (spore) => {
    await syncPut<FieldSporePrint>(db.fieldSpores, spore)
    await get().hydrate()
  },
  removeSpore: async (id) => {
    await syncDelete<FieldSporePrint>(db.fieldSpores, id)
    await get().hydrate()
  },
  saveIdentify: async (log) => {
    await syncPut<FieldIdentifyLog>(db.fieldIdentifies, log)
    await get().hydrate()
  },
  removeIdentify: async (id) => {
    await syncDelete<FieldIdentifyLog>(db.fieldIdentifies, id)
    await get().hydrate()
  }
}))
