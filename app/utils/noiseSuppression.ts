// adopted from https://github.com/jitsi/jitsi-meet/tree/master/react/features/stream-effects/noise-suppression

import { Observable } from 'rxjs'
import invariant from 'tiny-invariant'

/**
 * How hard the gate that runs after RNNoise suppresses non-speech audio.
 * `off` reproduces the original RNNoise-only behaviour.
 */
export const NOISE_SUPPRESSION_STRENGTHS = [
	'off',
	'light',
	'balanced',
	'strong',
] as const

export type NoiseSuppressionStrength =
	(typeof NOISE_SUPPRESSION_STRENGTHS)[number]

/**
 * Builds the rxjs operator for a given strength.
 *
 * A factory rather than a bare function so the caller gets a stable identity
 * per strength, which is what `addTransform` / `removeTransform` pair on.
 */
export function makeNoiseSuppression(strength: NoiseSuppressionStrength) {
	return function noiseSuppression(
		originalAudioStreamTrack: MediaStreamTrack
	): Observable<MediaStreamTrack> {
		return new Observable<MediaStreamTrack>((subscriber) => {
			const mediaStream = new MediaStream()
			mediaStream.addTrack(originalAudioStreamTrack)
			const suppressor = new NoiseSuppressionEffect()
			const output = suppressor.startEffect(mediaStream, strength)
			const noiseSuppressedTrack = output.getAudioTracks()[0]
			subscriber.add(() => {
				suppressor.stopEffect()
			})
			subscriber.next(noiseSuppressedTrack)
		})
	}
}

/**
 * Effect applies rnnoise denoising on a audio MediaStreamTrack.
 */
class NoiseSuppressionEffect {
	/**
	 * Web audio context.
	 */
	private _audioContext?: AudioContext

	/**
	 * Source that will be attached to the track affected by the effect.
	 */
	private _audioSource?: MediaStreamAudioSourceNode

	/**
	 * Destination that will contain denoised audio from the audio worklet.
	 */
	private _audioDestination?: MediaStreamAudioDestinationNode

	/**
	 * `AudioWorkletProcessor` associated node.
	 */
	private _noiseSuppressorNode?: AudioWorkletNode

	/**
	 * Transient gate node, chained after the denoiser.
	 *
	 * RNNoise preserves speech rather than gating, so impulsive transients like a
	 * mouse click survive it. This node adds the gate that RNNoise omits.
	 */
	private _transientGateNode?: AudioWorkletNode

	/**
	 * Audio track extracted from the original MediaStream to which the effect is applied.
	 */
	private _originalMediaTrack?: MediaStreamTrack

	/**
	 * Noise suppressed audio track extracted from the media destination node.
	 */
	private _outputMediaTrack?: MediaStreamTrack

	/**
	 * Applies effect that uses a {@code NoiseSuppressor} service initialized with {@code RnnoiseProcessor}
	 * for denoising, chained into a transient gate.
	 *
	 * @param {MediaStream} audioStream - Audio stream which will be mixed with _mixAudio.
	 * @param {NoiseSuppressionStrength} strength - How hard the gate suppresses non-speech audio.
	 * @returns {MediaStream} - MediaStream containing both audio tracks mixed together.
	 */
	startEffect(
		audioStream: MediaStream,
		strength: NoiseSuppressionStrength
	): MediaStream {
		this._audioContext = new AudioContext()
		this._originalMediaTrack = audioStream.getAudioTracks()[0]
		this._audioSource = this._audioContext.createMediaStreamSource(audioStream)
		this._audioDestination = this._audioContext.createMediaStreamDestination()
		this._outputMediaTrack = this._audioDestination.stream.getAudioTracks()[0]

		const workletUrl = `/noise/noise-suppressor-worklet.esm.js`
		const gateWorkletUrl = `/noise/transient-gate-worklet.js`

		// Connect the audio processing graph
		// MediaStream -> NoiseSuppressorWorklet -> TransientGateProcessor -> MediaStreamAudioDestinationNode
		this._audioContext.audioWorklet
			.addModule(workletUrl)
			.then(() => this._audioContext?.audioWorklet.addModule(gateWorkletUrl))
			.then(() => {
				invariant(this._audioContext)
				if (this._audioContext.state === 'closed') return
				// After the resolution of module loading, an AudioWorkletNode can be constructed.
				this._noiseSuppressorNode = new AudioWorkletNode(
					this._audioContext,
					'NoiseSuppressorWorklet',
					{ processorOptions: { strength } }
				)
				this._transientGateNode = new AudioWorkletNode(
					this._audioContext,
					'TransientGateProcessor',
					{ processorOptions: { strength } }
				)
				invariant(this._audioSource)
				invariant(this._audioDestination)
				this._audioSource
					.connect(this._noiseSuppressorNode)
					.connect(this._transientGateNode)
					.connect(this._audioDestination)
			})
			.catch((error) => {
				console.error(error)
			})

		// Sync the effect track muted state with the original track state.
		this._outputMediaTrack.enabled = this._originalMediaTrack.enabled

		// We enable the audio on the original track because mute/unmute action will only affect the audio destination
		// output track from this point on.
		this._originalMediaTrack.enabled = true

		return this._audioDestination.stream
	}

	/**
	 * Clean up resources acquired by noise suppressor and rnnoise processor.
	 *
	 * @returns {void}
	 */
	stopEffect(): void {
		// Sync original track muted state with effect state before removing the effect.
		invariant(this._originalMediaTrack)
		invariant(this._outputMediaTrack)
		this._originalMediaTrack.enabled = this._outputMediaTrack.enabled

		// Technically after this process the Audio Worklet along with it's resources should be garbage collected,
		// however on chrome there seems to be a problem as described here:
		// https://bugs.chromium.org/p/chromium/issues/detail?id=1298955
		this._noiseSuppressorNode?.port?.close()
		this._transientGateNode?.port?.close()
		this._audioDestination?.disconnect()
		this._transientGateNode?.disconnect()
		this._noiseSuppressorNode?.disconnect()
		this._audioSource?.disconnect()
		this._audioContext?.close()
	}
}
