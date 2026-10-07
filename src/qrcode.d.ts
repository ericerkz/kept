declare module 'qrcode' {
  export function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
}
