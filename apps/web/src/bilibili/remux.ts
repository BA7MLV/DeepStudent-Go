import {
  Input, BlobSource, MP4, Output, Mp4OutputFormat, BufferTarget,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
} from 'mediabunny';
import { biliText } from './text';

/** Copy encoded packets, without WebCodecs/FFmpeg or re-encoding. */
export async function remuxBiliMedia(video: Blob, audio: Blob | null, signal: AbortSignal): Promise<Blob> {
  const videoInput = new Input({ source: new BlobSource(video), formats: [MP4] });
  const audioInput = audio ? new Input({ source: new BlobSource(audio), formats: [MP4] }) : null;
  const target = new BufferTarget();
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'in-memory' }) });
  try {
    signal.throwIfAborted();
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const audioTrack = await (audioInput ?? videoInput).getPrimaryAudioTrack();
    if (!videoTrack || (audioInput && !audioTrack)) throw new Error(biliText('missingTracks'));
    const videoCodec = await videoTrack.getCodec(), videoConfig = await videoTrack.getDecoderConfig();
    if (!videoCodec || !videoConfig) throw new Error(biliText('videoCodec'));
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource, { rotation: await videoTrack.getRotation() });
    const audioCodec = await audioTrack?.getCodec(), audioConfig = await audioTrack?.getDecoderConfig();
    if (audioTrack && (!audioCodec || !audioConfig)) throw new Error(biliText('audioCodec'));
    const audioSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    // Await both producers even on failure before disposing their inputs.
    const results = await Promise.allSettled([
      (async () => {
        try {
          for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
            signal.throwIfAborted();
            await videoSource.add(packet, { decoderConfig: videoConfig });
          }
        } finally { videoSource.close(); }
      })(),
      (async () => {
        if (!audioTrack || !audioSource || !audioConfig) return;
        try {
          for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
            signal.throwIfAborted();
            await audioSource.add(packet, { decoderConfig: audioConfig });
          }
        } finally { audioSource.close(); }
      })(),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    signal.throwIfAborted();
    await output.finalize();
    if (!target.buffer?.byteLength) throw new Error(biliText('emptyMerge'));
    return new Blob([target.buffer], { type: 'video/mp4' });
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally { videoInput.dispose(); audioInput?.dispose(); }
}
