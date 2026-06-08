import { LabelI } from './labels';
import { ShareUserI } from './users';

export interface NoteI {
    id?: number
    syncId?: string
    ownerUserId?: number
    ownerDisplayName?: string
    ownerUsername?: string
    ownerAvatarDataUrl?: string
    ownerAvatarPreset?: string
    noteTitle: string
    noteBody?: string
    searchText?: string
    previewText?: string
    linkCount?: number
    nextCursor?: string
    isCardPreview?: boolean
    hasMoreImages?: boolean
    hasAttachments?: boolean
    attachmentCount?: number
    pinned: boolean
    bgColor: string
    bgImage: string
    checkBoxes?: CheckboxI[]
    images?: NoteImageI[]
    attachments?: NoteAttachmentI[]
    isCbox: boolean
    labels: LabelI[]
    archived: boolean
    trashed: boolean
    trashedAt?: string
    sortOrder?: number
    createdAt?: string
    updatedAt?: string
    lwwPhysicalMs?: number
    lwwLogical?: number
    lwwDeviceId?: string
    lwwOperationId?: string
    ownerOnline?: boolean
    lastEditorUserId?: number
    lastEditorDisplayName?: string
    collaborators?: ShareUserI[]
    isDemo?: boolean
}

export interface NoteImageI {
    id: string
    dataUrl: string
    name: string
    placement: 'top' | 'bottom'
}

export interface NoteAttachmentI {
    id: number
    syncId?: string
    noteId?: number
    originalName: string
    fileSize: number
    mimeType: string
    uploadedAt: string
    lwwPhysicalMs?: number
    lwwLogical?: number
    lwwDeviceId?: string
    lwwOperationId?: string
}

export interface CheckboxI {
    done: boolean,
    data: any,
    id: number
}

export type UpdateKeyI = {
    [key in keyof NoteI]?: any
}

export interface NoteModelI {
    id: number
    pinned: NoteI[]
    unpinned: NoteI[]
    all: NoteI[]
    db: {
        add(data: NoteI): Promise<number>
        update(data: NoteI): Promise<void>
        updateKey(object: UpdateKeyI): Promise<void>
        updateAllLabels(labelId: number, labelValue: string): Promise<void>
        uploadImage(file: File): Promise<{ url: string, name: string }>
        uploadAttachment(noteId: number, file: File): Promise<NoteAttachmentI>
        deleteAttachment(noteId: number, attachmentId: number): Promise<void>
        downloadAttachment(attachment: NoteAttachmentI): Promise<void>
        get(): Promise<NoteI>
        listShareUsers(): Promise<ShareUserI[]>
        getCollaborators(): Promise<ShareUserI[]>
        updateCollaborators(userIds: number[]): Promise<ShareUserI[]>
        reorder(ids: number[]): Promise<void>
        clone(): Promise<void>
        delete(): Promise<void>
        trash(): Promise<void>
    }
}
