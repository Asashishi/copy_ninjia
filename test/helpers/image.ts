/** 生成固定像素的 BMP 夹具；由原生图片 API 编码成各测试所需格式。 */
export function imageFixture(width: number, height: number): Uint8Array {
  const stride: number = Math.ceil(width * 3 / 4) * 4;
  const bytes: Uint8Array = new Uint8Array(54 + stride * height);
  const header: DataView = new DataView(bytes.buffer);
  header.setUint16(0, 0x4d42, true);
  header.setUint32(2, bytes.length, true);
  header.setUint32(10, 54, true);
  header.setUint32(14, 40, true);
  header.setInt32(18, width, true);
  header.setInt32(22, height, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, 24, true);
  header.setUint32(34, stride * height, true);
  let state: number = 42;
  for (let y: number = 0; y < height; y++) {
    for (let x: number = 0; x < width * 3; x++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[54 + y * stride + x] = state >>> 24;
    }
  }
  return bytes;
}

/** 两帧 2×2 GIF：首帧黄色，第二帧蓝色，逐帧间隔 100 ms。 */
export function animatedGifFixture(): Uint8Array {
  return Uint8Array.fromBase64(
    "R0lGODlhAgACAIAAAExpcf//ACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAgACAAACAoxTACH5BAUKAAAALAAAAAACAAIAgExpcQAA/wICjFMAOw=="
  );
}
