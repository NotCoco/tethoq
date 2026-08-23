declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}

// Internals the library expects to find on the global object rather than to
// import. They are opaque here: nothing calls them, they are only republished.
declare module "lamejs/src/js/MPEGMode.js" {
  const MPEGMode: unknown;
  export default MPEGMode;
}
declare module "lamejs/src/js/Lame.js" {
  const Lame: unknown;
  export default Lame;
}
declare module "lamejs/src/js/BitStream.js" {
  const BitStream: unknown;
  export default BitStream;
}
