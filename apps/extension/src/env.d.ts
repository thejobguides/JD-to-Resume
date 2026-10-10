/// <reference types="vite/client" />

declare const __API_URL__: string;
declare const __WEB_URL__: string;
declare const __CONFIG_PUBLIC_KEY__: string;
declare const __EXT_VERSION__: string;
declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_AUTH_URL__: string;

declare module 'pdfmake/build/pdfmake' {
  const pdfMake: {
    addVirtualFileSystem(vfs: Record<string, string>): void;
    setUrlAccessPolicy(fn: (url: string) => boolean): void;
    createPdf(dd: unknown): { getBlob(): Promise<Blob> };
  };
  export default pdfMake;
}
declare module 'pdfmake/build/vfs_fonts' {
  const vfs: Record<string, string>;
  export default vfs;
}
