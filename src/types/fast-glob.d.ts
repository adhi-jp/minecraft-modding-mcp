declare module "fast-glob" {
  export interface FastGlobOptions {
    cwd?: string;
    onlyFiles?: boolean;
    absolute?: boolean;
    dot?: boolean;
    ignore?: string[];
  }

  export interface FastGlob {
    sync(pattern: string | string[], options?: FastGlobOptions): string[];
  }

  const fg: FastGlob;
  export default fg;
}
