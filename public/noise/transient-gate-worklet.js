/**
 * Transient gate worklet.
 *
 * Runs after the RNNoise worklet in the same AudioContext. RNNoise is a
 * speech-preserving denoiser: its job is to thin out stationary background noise
 * while keeping speech intelligible, not to gate. Impulsive transients — a mouse
 * click, key clatter, a pen tap — are acoustically very close to speech onsets,
 * because plosive consonants like /t/, /k/ and /p/ are themselves short broadband
 * bursts. A model tuned to protect speech is therefore deliberately conservative
 * about exactly this class of sound, which is why clicks survive it.
 *
 * This stage adds the gating RNNoise intentionally omits.
 *
 * Self-contained on purpose: an AudioWorklet is fetched standalone by
 * `addModule()` and cannot import app modules. The DSP therefore lives in plain
 * classes below, exported so the thresholds can be unit tested under node, and
 * the worklet-global parts are guarded at the bottom of the file.
 */

export const STRENGTHS = ['off', 'light', 'balanced', 'strong']

/** Time constants for the envelope followers, in seconds. */
const ENV_FAST = { attack: 0.005, release: 0.15 }
const ENV_SLOW = { attack: 0.3, release: 2.0 }
// A third, slower follower used purely to decide whether we are already inside
// a burst of continuous sound. A click arrives out of quiet; a plosive arrives
// mid-utterance. This is what tells the two apart.
const ENV_CONTEXT = { attack: 0.2, release: 1.5 }

/**
 * Corner frequency of the one-pole used to measure high-frequency content.
 *
 * Deliberately 4 kHz rather than 2 kHz: a mechanical click carries real energy
 * well up into this range, whereas a plosive burst is concentrated in the low
 * mids. Measuring at 2 kHz made the two look identical and gated speech.
 */
const HIGH_PASS_HZ = 4000

const BASE = {
	// --- transient (click) detector ---
	// A click is peaky, broadband, and arrives out of quiet.
	crestThreshold: 3.2, // peak / rms
	hfThreshold: 0.25, // share of energy above the high-pass corner
	onsetThreshold: 2.2, // fast envelope / slow envelope
	floorRatio: 2.5, // rms must clear this multiple of the noise floor
	floorMin: 0.0015, // absolute floor, so silence cannot trigger anything
	floorRise: 0.0004, // how fast the floor is allowed to creep up
	floorFall: 0.35, // how fast it tracks downward
	transientHangover: 0.12, // seconds held after a detected transient

	// --- speech context ---
	// Inside continuous sound we tighten every test, so a click landing while
	// someone is still talking can be caught without eating a plosive.
	contextRatio: 6.0, // envContext must clear this multiple of floor to count
	contextCrestStrictness: 1.9,
	contextHfStrictness: 1.7,
	contextOnsetStrictness: 1.8,

	// --- voice gate ---
	voiceRatio: 4.0, // rms must clear this multiple of floor to count as voice
	voiceHangover: 0.35, // seconds

	// --- output smoothing ---
	attack: 0.003, // seconds; fast so a click is killed on its first quantum
	release: 0.03,

	// null disables the voice gate (clicks-only mode)
	voiceGate: null,
}

/**
 * Strength presets.
 *
 * `off` is a true bypass and reproduces the pre-gate behaviour exactly.
 * `light` is clicks-only and cannot fire on speech.
 * `balanced` and `strong` trade a little onset quality for a much quieter room.
 */
export const PRESETS = {
	off: { ...BASE, bypass: true },
	light: { ...BASE, bypass: false, voiceGate: null },
	balanced: { ...BASE, bypass: false, voiceGate: 0.126 }, // -18 dB
	strong: { ...BASE, bypass: false, voiceGate: 0.01, voiceHangover: 0.08, release: 0.02 },
}

export function presetFor(strength) {
	return PRESETS[strength] ?? PRESETS.balanced
}

/** One-pole coefficient for a time constant, given a block duration. */
function coefficient(timeConstant, blockDuration) {
	if (timeConstant <= 0) return 1
	return 1 - Math.exp(-blockDuration / timeConstant)
}

function dbToGain(db) {
	return Math.pow(10, db / 20)
}

/**
 * Per-channel analysis and gain state.
 *
 * Kept separate from the worklet wrapper so it can be driven directly by tests
 * with plain Float32Arrays.
 */
export class GateChannel {
	constructor(sampleRate, frameSize, config) {
		this.sampleRate = sampleRate
		this.frameSize = frameSize
		this.config = config

		const blockDuration = frameSize / sampleRate
		this.fastAttack = coefficient(ENV_FAST.attack, blockDuration)
		this.fastRelease = coefficient(ENV_FAST.release, blockDuration)
		this.slowAttack = coefficient(ENV_SLOW.attack, blockDuration)
		this.slowRelease = coefficient(ENV_SLOW.release, blockDuration)
		this.contextAttack = coefficient(ENV_CONTEXT.attack, blockDuration)
		this.contextRelease = coefficient(ENV_CONTEXT.release, blockDuration)

		this.attackCoef = coefficient(config.attack, 1 / sampleRate)
		this.releaseCoef = coefficient(config.release, 1 / sampleRate)

		this.highPassCoef = 1 - Math.exp((-2 * Math.PI * HIGH_PASS_HZ) / sampleRate)

		this.transientHangoverSamples = Math.round(config.transientHangover * sampleRate)
		this.voiceHangoverSamples = Math.round(config.voiceHangover * sampleRate)

		this.reset()
	}

	reset() {
		this.envFast = 0
		this.envSlow = 0
		this.envContext = 0
		this.floor = this.config.floorMin
		this.gain = 1
		this.hpPrevIn = 0
		this.hpPrevOut = 0
		this.hpEnergy = 0
		this.transientHold = 0
		this.voiceHold = 0
		this.position = 0
	}

	/** Follow an envelope: rise quickly, fall slowly (or the reverse). */
	_follow(value, attackCoef, releaseCoef, current) {
		const coef = value > current ? attackCoef : releaseCoef
		return current + (value - current) * coef
	}

	/**
	 * Analyse one block of `input`, returning the target gain for that block.
	 * `index` is the absolute sample position, used for the hangovers.
	 */
	analyse(input, index) {
		const config = this.config

		let sumSquares = 0
		let peak = 0
		let hpSquares = 0
		let hpPrevIn = this.hpPrevIn
		let hpPrevOut = this.hpPrevOut

		for (let i = 0; i < input.length; i++) {
			const x = input[i]
			sumSquares += x * x
			const magnitude = x < 0 ? -x : x
			if (magnitude > peak) peak = magnitude

			// One-pole high-pass, used only to measure how much of the energy
			// sits above the corner. A mechanical click is broadband, so this is
			// what keeps a low thump from tripping the detector.
			const hp = this.highPassCoef * (hpPrevOut + x - hpPrevIn)
			hpPrevIn = x
			hpPrevOut = hp
			hpSquares += hp * hp
		}

		this.hpPrevIn = hpPrevIn
		this.hpPrevOut = hpPrevOut

		const length = Math.max(input.length, 1)
		const rms = Math.sqrt(sumSquares / length)
		const hpRms = Math.sqrt(hpSquares / length)

		// Adaptive noise floor, min-statistics style: drop fast, creep up slowly.
		this.floor = this._follow(rms, config.floorRise, config.floorFall, this.floor)
		if (this.floor < config.floorMin) this.floor = config.floorMin

		this.envFast = this._follow(rms, this.fastAttack, this.fastRelease, this.envFast)
		this.envSlow = this._follow(rms, this.slowAttack, this.slowRelease, this.envSlow)

		this.envContext = this._follow(
			rms,
			this.contextAttack,
			this.contextRelease,
			this.envContext
		)

		const crest = peak / (rms + 1e-9)
		const hfRatio = hpRms / (rms + 1e-9)
		const onsetRatio = this.envFast / (this.envSlow + 1e-9)

		// Inside continuous sound every test gets stricter. A click landing while
		// someone is still talking is still catchable; a plosive is not, and the
		// two are otherwise near-indistinguishable on an onset test alone.
		const inSpeechContext = this.envContext > this.floor * config.contextRatio
		const crestLimit = inSpeechContext
			? config.crestThreshold * config.contextCrestStrictness
			: config.crestThreshold
		const hfLimit = inSpeechContext
			? config.hfThreshold * config.contextHfStrictness
			: config.hfThreshold
		const onsetLimit = inSpeechContext
			? config.onsetThreshold * config.contextOnsetStrictness
			: config.onsetThreshold

		const aboveFloor = rms > this.floor * config.floorRatio
		const isTransient =
			crest > crestLimit &&
			hfRatio > hfLimit &&
			onsetRatio > onsetLimit &&
			aboveFloor

		if (isTransient) {
			this.transientHold = index + this.transientHangoverSamples
		}

		if (rms > this.floor * config.voiceRatio) {
			this.voiceHold = index + this.voiceHangoverSamples
		}

		const transientActive = index < this.transientHold
		const voiceActive = index < this.voiceHold

		if (transientActive) return 0
		if (config.voiceGate !== null && !voiceActive) return config.voiceGate
		return 1
	}

	/** Apply a target gain across a block, smoothing the transition per sample. */
	apply(input, output, targetGain) {
		const attackCoef = this.attackCoef
		const releaseCoef = this.releaseCoef
		let gain = this.gain

		for (let i = 0; i < input.length; i++) {
			// Fall fast so a click dies on its first quantum, rise slowly so the
			// gate itself does not add a zipper artefact.
			gain += (targetGain - gain) * (targetGain < gain ? attackCoef : releaseCoef)
			output[i] = input[i] * gain
		}

		this.gain = gain
		this.position += input.length
	}
}

/**
 * Whole-processor gate: analyses all input channels together, then applies one
 * shared gain to each. A click normally lands in both channels, and gating them
 * together avoids a half-filtered click.
 */
export class TransientGate {
	constructor(sampleRate, frameSize, config) {
		this.config = config
		this.frameSize = frameSize
		this.position = 0
		this.channels = Array.from(
			{ length: 2 },
			() => new GateChannel(sampleRate, frameSize, config)
		)
	}

	process(inputs, outputs) {
		if (this.config.bypass) {
			for (let c = 0; c < outputs.length; c++) {
				const input = inputs[c]
				const output = outputs[c]
				if (!input || !output) continue
				for (let i = 0; i < output[0].length; i++) {
					output[0][i] = input[0][i]
					if (output[1] && input[1]) output[1][i] = input[1][i]
				}
			}
			return true
		}

		const channelCount = Math.min(outputs.length, this.channels.length)
		if (channelCount === 0) return true

		let targetGain = 1
		for (let c = 0; c < channelCount; c++) {
			const input = inputs[c]?.[0]
			if (!input) continue
			// The transient and voice decisions are the strictest across channels,
			// so a click in one channel silences the block.
			targetGain = Math.min(targetGain, this.channels[c].analyse(input, this.position))
		}

		for (let c = 0; c < channelCount; c++) {
			const input = inputs[c]?.[0]
			if (!input) continue
			for (let ch = 0; ch < 2; ch++) {
				const inputCh = inputs[c][ch]
				const outputCh = outputs[c][ch]
				if (!inputCh || !outputCh) continue
				this.channels[c].apply(inputCh, outputCh, targetGain)
			}
		}

		this.position += this.frameSize
		return true
	}
}

/* Worklet-global wiring. Guarded so this module can be imported under node,
 * where AudioWorkletProcessor and registerProcessor do not exist. */
if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
	// eslint-disable-next-line no-undef
	class TransientGateProcessor extends AudioWorkletProcessor {
		constructor(options) {
			super()
			const strength = options?.processorOptions?.strength ?? 'balanced'
			this.gate = new TransientGate(
				sampleRate,
				128,
				presetFor(strength)
			)
		}

		process(inputs, outputs) {
			return this.gate.process(inputs, outputs)
		}
	}

	registerProcessor('TransientGateProcessor', TransientGateProcessor)
}
