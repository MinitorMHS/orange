import { beforeAll, describe, expect, it } from 'vitest'

let Channel
let RNNOISE_GATE_PRESETS

// The worklet calls `registerProcessor` at module scope, which only exists
// inside an AudioWorkletGlobalScope, so stub it before the dynamic import.
beforeAll(async () => {
	globalThis.AudioWorkletProcessor = class {
		constructor() {
			this.port = { onmessage: null, postMessage() {} }
		}
	}
	globalThis.registerProcessor = () => {}
	globalThis.sampleRate = 48000
	;({ Channel, RNNOISE_GATE_PRESETS } = await import(
		'./noise-suppressor-worklet.esm.js'
	))
})

const DenoiseSize = 480
const ProcSize = 128

/** Stub RNNoise: halves the frame (a fake "denoise") and reports `score`. */
function stubProcessor(score) {
	return {
		processAudioFrame(frame) {
			for (let i = 0; i < frame.length; i++) frame[i] *= 0.5
			return score
		},
	}
}

/** Per-frame RMS over `frames` frames of constant `value`. */
function measure(gate, score, frames = 400, value = 1) {
	const channel = new Channel(stubProcessor(score), DenoiseSize, gate)
	const inBuf = new Float32Array(ProcSize).fill(value)
	const outBuf = new Float32Array(ProcSize)
	const rms = []
	for (let i = 0; i < frames; i++) {
		inBuf.fill(value)
		channel.process(inBuf, outBuf)
		let sum = 0
		for (const v of outBuf) sum += v * v
		rms.push(Math.sqrt(sum / outBuf.length))
	}
	return rms
}

/**
 * Median RMS of the settled tail. `Channel` buffers a full circular pass
 * before emitting, so early frames read as silence by design.
 */
function settledRms(gate, score) {
	const rms = measure(gate, score).slice(300)
	rms.sort((a, b) => a - b)
	return rms[rms.length >> 1]
}

describe('RNNoise VAD gate', () => {
	it('off reproduces the RNNoise output exactly', () => {
		const a = settledRms(RNNOISE_GATE_PRESETS.off, 0)
		const b = settledRms(RNNOISE_GATE_PRESETS.off, 0)
		expect(a).toBeGreaterThan(0)
		expect(a).toBe(b)
	})

	it('strong attenuates frames the VAD scores as non-speech', () => {
		const pass = settledRms(RNNOISE_GATE_PRESETS.off, 0)
		const gated = settledRms(RNNOISE_GATE_PRESETS.strong, 0)
		expect(gated).toBeLessThan(pass * 0.75)
	})

	it('attenuates more the stronger the preset', () => {
		const r = ['light', 'balanced', 'strong'].map((s) =>
			settledRms(RNNOISE_GATE_PRESETS[s], 0)
		)
		expect(r[0]).toBeGreaterThan(r[1])
		expect(r[1]).toBeGreaterThan(r[2])
	})

	it('leaves VAD-confirmed speech unattenuated at every strength', () => {
		const pass = settledRms(RNNOISE_GATE_PRESETS.off, 0.99)
		for (const s of ['light', 'balanced', 'strong']) {
			expect(settledRms(RNNOISE_GATE_PRESETS[s], 0.99)).toBeGreaterThan(
				pass * 0.97
			)
		}
	})

	it('never applies more than unity gain', () => {
		for (const gate of Object.values(RNNOISE_GATE_PRESETS)) {
			if (gate.attenuation === 0) continue
			// Stub "denoise" halves the signal, so 0.5 is full unity gain.
			expect(settledRms(gate, 0)).toBeLessThanOrEqual(0.5 + 1e-6)
		}
	})
})
