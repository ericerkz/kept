export interface LabelI {
    syncId?: string
    updatedAt?: string
    id?: number
    name: string
    sortOrder?: number | null
    added?: boolean
}

export type LabelActionsT = {
    update: (data: string) => void
    delete: () => void
}

export type UpdateKeyI = {
    [key in keyof LabelI]?: any
}

export interface LabelModelI {
    id: number
    list: LabelI[]
    db: {
        add(data: LabelI): Promise<any>
        update(data: UpdateKeyI): Promise<void>
        delete(): Promise<void>
        reorder(labels: LabelI[]): Promise<void>
        updateAllLabels(value: string): Promise<void>
    }
}
