/**
 * 语音基准共用的 WAV 夹具：24 kHz 单声道 16 bit PCM，与供应商语音合成默认交回的容器一致。
 * 波形由几个固定频率叠加而成，每次生成的字节完全相同；不导入任何生产模块。
 */

/** 供应商语音合成交回的采样率。 */
const WAV_SAMPLE_RATE: number = 24_000;

/** RIFF/WAVE 头长度：RIFF 12 字节 + fmt 子块 24 字节 + data 子块头 8 字节。 */
const WAV_HEADER_BYTES: number = 44;

/**
 * 生成指定 PCM 字节数的 WAV 容器（向下取整到整样本）。
 * @param pcmBytes data 子块的目标字节数。
 */
export function benchmarkWav(pcmBytes: number): Uint8Array<ArrayBuffer> {
  const samples: number = Math.floor(pcmBytes / 2);
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(WAV_HEADER_BYTES + samples * 2);
  const view: DataView = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index: number = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, WAV_HEADER_BYTES - 8 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index: number = 0; index < samples; index++) {
    const time: number = index / WAV_SAMPLE_RATE;
    const value: number = 0.3 * Math.sin(2 * Math.PI * 220 * time) +
      0.15 * Math.sin(2 * Math.PI * 660 * time) +
      0.05 * Math.sin(2 * Math.PI * 1_870 * time);
    view.setInt16(WAV_HEADER_BYTES + index * 2, Math.round(value * 32_767), true);
  }
  return bytes;
}
