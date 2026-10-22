declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  export type HeifImage = {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    display(target: ImageData, done: (out: ImageData | null) => void): void;
    free(): void;
  };
  export type Libheif = { HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] } };
  const factory: () => Libheif;
  export default factory;
}
