export type UserRole = 'admin' | 'user'
export type UserTheme = 'dark' | 'light'

export interface UserI {
    id?: number
    username: string
    displayName: string
    role: UserRole
    theme: UserTheme
    avatarDataUrl: string
    avatarPreset: string
    totpEnabled?: boolean
    hasBackupCodes?: boolean
    email?: string
    enabled?: boolean
    createdAt: string
    demoNotesCreatedAt?: string | null
}

export interface AuthSessionI {
    token: string
    id: number
    username: string
    displayName: string
    role: UserRole
    theme: UserTheme
    avatarDataUrl: string
    avatarPreset: string
    totpEnabled?: boolean
    hasBackupCodes?: boolean
    demoNotesCreatedAt?: string | null
}

export interface ShareUserI {
    id: number
    username: string
    displayName: string
    avatarDataUrl: string
    avatarPreset: string
    shareCount: number
    online?: boolean
}
