import { describe, expect, it } from 'vitest'
import {
	GateChannel,
	PRESETS,
	TransientGate,
	presetFor,
} from './transient-gate-worklet.js'

const SAMPLE_RATE = 48000
const FRAME = 128

/** Deterministic noise, so a failure is always reproducible. */
function makeRandom(seed) {
	let state = seed
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		return state / 0x7fffffff - 0.5
	}
}

/** Drives a signal through a GateChannel, recording the decided gain per frame. */
function run(signal, strength = 'light') {
	const channel = new GateChannel(SAMPLE_RATE, FRAME, presetFor(strength))
	const targets = []
	const gains = []
	const scratch = new Float32Array(FRAME)
	let index = 0
	for (let offset = 0; offset + FRAME <= signal.length; offset += FRAME) {
		const block = signal.subarray(offset, offset + FRAME)
		const target = channel.analyse(block, index)
		targets.push(target)
		channel.apply(block, scratch, target)
		gains.push(channel.gain)
		index += FRAME
	}
	return { targets, gains }
}

/** Near-silence with periodic decaying broadband bursts: a mouse-click train. */
function clickTrain({ clicks = 6, period = 0.3, amplitude = 0.6 } = {}) {
	const random = makeRandom(7)
	const length = Math.round(SAMPLE_RATE * period * clicks)
	const out = new Float32Array(length)
	for (let i = 0; i < length; i++) out[i] = random() * 0.0006

	const clickLength = Math.round(0.004 * SAMPLE_RATE)
	const starts = []
	for (let c = 0; c < clicks; c++) {
		const start = Math.round(c * period * SAMPLE_RATE)
		starts.push(start)
		for (let i = 0; i < clickLength && start + i < length; i++) {
			out[start + i] +=
				random() * amplitude * Math.exp(-i / (0.0008 * SAMPLE_RATE))
		}
	}
	return { signal: out, starts }
}

/** Steady low-level noise, like room tone or a fan. */
function steadyNoise(seconds = 1.5, amplitude = 0.01) {
	const random = makeRandom(21)
	const length = Math.round(SAMPLE_RATE * seconds)
	const out = new Float32Array(length)
	for (let i = 0; i < length; i++) out[i] = random() * amplitude
	return out
}

/**
 * A voiced-speech-like signal: a harmonic stack under a syllabic amplitude
 * envelope, with a plosive burst in the middle of the utterance. The burst is
 * the regression this whole feature exists to avoid — it is acoustically very
 * close to a mouse click, and gating it would clip the user's consonants.
 */
function speechWithPlosive(seconds = 1.5) {
	const length = Math.round(SAMPLE_RATE * seconds)
	const out = new Float32Array(length)
	const f0 = 120
	for (let i = 0; i < length; i++) {
		const t = i / SAMPLE_RATE
		const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)
		let value = 0
		for (let h = 1; h <= 10; h++) value += Math.sin(2 * Math.PI * f0 * h * t) / h
		out[i] = value * envelope * 0.06
	}
	const random = makeRandom(99)
	const start = Math.round(SAMPLE_RATE * (seconds / 2))
	const burst = Math.round(0.004 * SAMPLE_RATE)
	for (let i = 0; i < burst; i++) {
		out[start + i] +=
			random() * 0.35 * Math.exp(-i / (0.0006 * SAMPLE_RATE))
	}
	return out
}

describe('transient gate', () => {
	it('mutes impulsive clicks that arrive out of quiet', () => {
		const { signal, starts } = clickTrain()
		const { targets } = run(signal, 'light')
		for (const start of starts) {
			const frame = Math.floor(start / FRAME)
			expect(targets.slice(frame - 2, frame + 6)).toContain(0)
		}
	})

	it('leaves steady room noise alone', () => {
		const { targets } = run(steadyNoise(), 'light')
		expect(targets.every((target) => target > 0)).toBe(true)
	})

	it('does not gate a plosive inside continuous speech', () => {
		const { targets } = run(speechWithPlosive(), 'light')
		expect(targets.every((target) => target > 0)).toBe(true)
	})

	it('recovers to full gain after the last click', () => {
		const { gains } = run(clickTrain().signal, 'light')
		expect(gains[gains.length - 1]).toBeGreaterThan(0.9)
	})

	it('passes the signal through untouched at off', () => {
		const signal = steadyNoise(0.2, 0.05)
		const gate = new TransientGate(SAMPLE_RATE, FRAME, PRESETS.off)
		const outputs = [[new Float32Array(signal.length)]]
		gate.process([[signal]], outputs)
		expect(Array.from(outputs[0][0])).toEqual(Array.from(signal))
	})

	it('fades non-speech in balanced mode but not at light', () => {
		const noise = steadyNoise(1, 0.01)
		expect(run(noise, 'light').targets.every((t) => t === 1)).toBe(true)
		expect(run(noise, 'balanced').targets.every((t) => t < 1)).toBe(true)
	})
})
