declare module 'gray-matter' {
  interface GrayMatterOption {
    excerpt?: boolean | ((file: GrayMatterFile, options: GrayMatterOption) => void);
    excerpt_separator?: string;
    engines?: Record<string, any>;
    language?: string;
    delimiters?: string | [string, string];
  }

  interface GrayMatterFile {
    data: Record<string, any>;
    content: string;
    excerpt?: string;
    orig: string | Buffer;
    language: string;
    matter: string;
    stringify(lang?: string): string;
    isEmpty: boolean;
  }

  function matter(input: string | Buffer, options?: GrayMatterOption): GrayMatterFile;

  export = matter;
}
