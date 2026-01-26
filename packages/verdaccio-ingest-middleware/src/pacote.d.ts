declare module 'pacote' {
  export interface ManifestResult {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    dist?: {
      tarball: string;
      shasum: string;
      integrity?: string;
    };
    os?: string[];
    cpu?: string[];
    [key: string]: any;
  }

  export interface PackumentResult {
    name: string;
    'dist-tags': Record<string, string>;
    versions: Record<string, ManifestResult>;
    time?: Record<string, string>;
    [key: string]: any;
  }

  export interface PacoteOptions {
    registry?: string;
    fullMetadata?: boolean;
    preferOnline?: boolean;
    cache?: string;
    [key: string]: any;
  }

  export function manifest(spec: string, opts?: PacoteOptions): Promise<ManifestResult>;
  export function packument(spec: string, opts?: PacoteOptions): Promise<PackumentResult>;
  export function tarball(spec: string, opts?: PacoteOptions): Promise<Buffer>;
  export function extract(spec: string, dest: string, opts?: PacoteOptions): Promise<void>;

  namespace tarball {
    function stream(spec: string, opts?: PacoteOptions): NodeJS.ReadableStream;
    function file(spec: string, dest: string, opts?: PacoteOptions): Promise<void>;
  }
}
