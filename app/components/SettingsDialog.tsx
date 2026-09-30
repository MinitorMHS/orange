import type { FC, ReactNode } from 'react'
import { useRoomContext } from '~/hooks/useRoomContext'
import { NOISE_SUPPRESSION_STRENGTHS } from '~/utils/noiseSuppression'
import { AudioInputSelector } from './AudioInputSelector'
import { Button } from './Button'
import {
	Dialog,
	DialogContent,
	DialogOverlay,
	DialogTitle,
	Portal,
	Trigger,
} from './Dialog'
import { Icon } from './Icon/Icon'
import { Label } from './Label'
import { Option, Select } from './Select'
import { Toggle } from './Toggle'
import { Tooltip } from './Tooltip'
import { VideoInputSelector } from './VideoInputSelector'

/** Human-readable names for each strength, keyed by the stored value. */
const STRENGTH_LABELS: Record<(typeof NOISE_SUPPRESSION_STRENGTHS)[number], string> =
	{
		off: 'Off',
		light: 'Light',
		balanced: 'Balanced',
		strong: 'Strong',
	}

interface SettingsDialogProps {
	onOpenChange?: (open: boolean) => void
	open?: boolean
	children?: ReactNode
}

export const SettingsButton = () => {
	return (
		<SettingsDialog>
			<Tooltip content="Settings">
				<Trigger asChild>
					<Button className="text-sm" displayType="secondary">
						<Icon type="cog" />
					</Button>
				</Trigger>
			</Tooltip>
		</SettingsDialog>
	)
}

export const SettingsDialog: FC<SettingsDialogProps> = ({
	onOpenChange,
	open,
	children,
}) => {
	const {
		userMedia: {
			blurVideo,
			setBlurVideo,
			suppressNoise,
			setSuppressNoise,
			noiseSuppressionStrength,
			setNoiseSuppressionStrength,
		},
	} = useRoomContext()

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{children}
			<Portal>
				<DialogOverlay />
				<DialogContent>
					<DialogTitle>Settings</DialogTitle>
					<div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-4 mt-8 items-center">
						<Label
							className="text-base -mb-2 md:mb-0 text-left md:text-right"
							htmlFor="camera"
						>
							Camera
						</Label>
						<VideoInputSelector id="camera" />
						<Label
							className="text-base -mb-2 md:mb-0 text-left md:text-right"
							htmlFor="mic"
						>
							Mic
						</Label>
						<AudioInputSelector id="mic" />
						<Label
							className="text-base -mb-2 md:mb-0 text-left md:text-right"
							htmlFor="blurBackground"
						>
							Blur Background
						</Label>
						<div>
							<Toggle
								id="blurBackground"
								checked={blurVideo}
								onCheckedChange={setBlurVideo}
							/>
						</div>
						<Label
							className="text-base -mb-2 md:mb-0 text-left md:text-right"
							htmlFor="suppressNoise"
						>
							Suppress Noise
						</Label>
						<div>
							<Toggle
								id="suppressNoise"
								checked={suppressNoise}
								onCheckedChange={setSuppressNoise}
							/>
						</div>
						<Label
							className="text-base -mb-2 md:mb-0 text-left md:text-right"
							htmlFor="noiseSuppressionStrength"
						>
							Noise Filtering
						</Label>
						<Select
							id="noiseSuppressionStrength"
							value={noiseSuppressionStrength}
							onValueChange={setNoiseSuppressionStrength}
							disabled={!suppressNoise}
							tooltipContent="How hard non-speech audio is filtered out. Strong removes the most, but can clip quiet parts of speech."
						>
							{NOISE_SUPPRESSION_STRENGTHS.map((strength) => (
								<Option key={strength} value={strength}>
									{STRENGTH_LABELS[strength]}
								</Option>
							))}
						</Select>
					</div>
				</DialogContent>
			</Portal>
		</Dialog>
	)
}
