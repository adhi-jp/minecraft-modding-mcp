declare module "fast-glob" {
  export interface FastGlobOptions {
    cwd?: string;
    onlyFiles?: boolean;
    absolute?: boolean;
    dot?: boolean;
    ignore?: string[];
  }

  export interface FastGlob {
    glob(pattern: string | string[], options?: FastGlobOptions): Promise<string[]>;
    sync(pattern: string | string[], options?: FastGlobOptions): string[];
  }

  const fg: FastGlob;
  export default fg;
}
