// Build metadata injected by Vite (`define` in vite.config.ts). Guarded so tests and tools without the define still work.
declare const __BUILD_SHA__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const BUILD_SHA: string = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev';
export const BUILD_TIME: string | null = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : null;
